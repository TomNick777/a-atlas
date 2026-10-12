"""Single CUDA RLCD continuation with exact optimizer-boundary resume."""
from __future__ import annotations
import argparse
import copy
from collections import defaultdict
import json
import math
import os
import random
import sys
import platform
from importlib.metadata import version
import time
from pathlib import Path
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from artifacts import ROOT, sha, atomic_json, model_path, private_path, registry, model_manifest, artifact_digest

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config")
    parser.add_argument("--init")
    parser.add_argument("--run", required=True)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    if not args.run.replace("-", "").replace("_", "").isalnum():
        raise ValueError("Invalid run ID")
    run = ROOT / "models/runs" / args.run
    if args.resume:
        config = json.loads((run / "config.json").read_text(encoding="utf-8"))
    else:
        if run.exists():
            raise ValueError("Run already exists; use resume")
        config = json.loads(Path(args.config).read_text(encoding="utf-8"))
        config["init"] = args.init
        run.mkdir(parents=True)
        atomic_json(run / "config.json", config)
    def status(state, **fields):
        atomic_json(run / "status.json", {"state": state, "run": args.run, "pid": os.getpid(), "updatedAt": time.time(), **fields})
    status("running", phase="loading")
    try:
        import numpy as np
        import torch
        from safetensors.torch import load_file
        from transformers import AutoTokenizer
        from laya.common import build_model, proper_reward
        sys.path.insert(0, str(ROOT / "training/laya/legacy"))
        from train_laya import collate, save_checkpoint
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA unavailable; training cannot run")
        torch.use_deterministic_algorithms(True)
        torch.backends.cudnn.deterministic = True
        torch.backends.cudnn.benchmark = False
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cuda.enable_flash_sdp(False)
        torch.backends.cuda.enable_mem_efficient_sdp(False)
        torch.backends.cuda.enable_math_sdp(True)
        seed = config.get("seed", 42)
        random.seed(seed); np.random.seed(seed); torch.manual_seed(seed); torch.cuda.manual_seed_all(seed)
        checkpoint, initial = model_path(config["init"])
        dataset_path = private_path(config["dataset"], "data")
        tokenized = json.loads(dataset_path.read_text(encoding="utf-8"))
        source_path = private_path(tokenized["source"], "data")
        items_path = private_path(tokenized["items"], "data")
        if sha(source_path) != tokenized["sourceSha256"] or sha(items_path) != tokenized["itemsSha256"]:
            raise ValueError("Dataset integrity mismatch")
        if tokenized["tokenizerSha256"] != initial["sha256"]:
            raise ValueError("Tokenizer/input model identity mismatch")
        all_items = torch.load(items_path, weights_only=False)
        items = [item for item in all_items if item["split"] == "train"]
        validation = [item for item in all_items if item["split"] == "validation"]
        source_manifest = json.loads(source_path.read_text(encoding="utf-8"))
        controlled = source_manifest.get("purpose", "").startswith("controlled")
        if not controlled:
            sys.path.insert(0, str(ROOT / "training/laya/datasets"))
            from groups import validate, validate_coverage
            validate(source_manifest["tasks"])
            validate_coverage(source_manifest["tasks"])
            required = {"semantic_match", "semantic_relation", "semantic_comparison", "evidence_explanation"}
            for split in ("train", "validation", "blind"):
                if {task["capability"] for task in source_manifest["tasks"] if task["split"] == split} != required:
                    raise ValueError(f"Product dataset requires all capabilities in {split}")
        if not controlled and not validation:
            raise ValueError("Product training requires an independent validation split")
        if not items:
            raise ValueError("Training split is empty")
        cfg = json.loads((checkpoint / "rl_agent_config.json").read_text(encoding="utf-8"))
        tokenizer = AutoTokenizer.from_pretrained(checkpoint / "tokenizer", local_files_only=True)
        model = build_model(cfg, encoder_dir=str(checkpoint / "encoder"))
        model.load_state_dict(load_file(str(checkpoint / "model.safetensors")), strict=True)
        model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        model.head_checkpointing = True
        model.to("cuda"); model.train()
        optimizer = torch.optim.AdamW(model.parameters(), lr=config.get("lr", 1e-5), weight_decay=0.01)
        micro, accum, epochs = config.get("microBatch", 1), config.get("gradAccum", 1), config.get("epochs", 1)
        if min(micro, accum, epochs) < 1:
            raise ValueError("Training counts must be positive")
        steps = math.ceil(math.ceil(len(items) / micro) / accum) * epochs
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, steps), eta_min=1e-6)
        identity = {"config": config, "datasetSha256": sha(dataset_path), "sourceSha256": tokenized["sourceSha256"], "itemsSha256": tokenized["itemsSha256"], "parentSha256": initial["sha256"], "torch": torch.__version__, "numpy": np.__version__}
        identity["software"] = {"python": platform.python_version(), **{package: version(package) for package in ("laya", "transformers", "safetensors")}}
        identity["trainerSha256"] = sha(Path(__file__))
        identity["helperSha256"] = sha(ROOT / "training/laya/legacy/train_laya.py")
        identity["parentArtifactDigest"] = initial["artifactDigest"]
        identity["cuda"] = {"runtime": torch.version.cuda, "device": torch.cuda.get_device_name(0), "capability": torch.cuda.get_device_capability(0)}
        if not controlled:
            identity["groupValidatorSha256"] = sha(ROOT / "training/laya/datasets/groups.py")
        best_validation = float("inf")
        epoch = cursor = step = 0
        order = list(range(len(items))); random.shuffle(order)
        if args.resume:
            saved = torch.load(run / "resume.pt", map_location="cpu", weights_only=False)
            if saved["identity"] != identity:
                raise ValueError("Resume identity mismatch (configuration, data, parent or software)")
            model.load_state_dict(saved["model"], strict=True)
            optimizer.load_state_dict(saved["optimizer"]); scheduler.load_state_dict(saved["scheduler"])
            random.setstate(saved["pythonRng"]); np.random.set_state(saved["numpyRng"])
            torch.set_rng_state(saved["torchRng"]); torch.cuda.set_rng_state_all(saved["cudaRng"])
            epoch, cursor, step, order = saved["epoch"], saved["cursor"], saved["step"], saved["order"]
            best_validation = saved.get("bestValidation", float("inf"))
        def save_resume():
            status("checkpointing", epoch=epoch, cursor=cursor, step=step)
            payload = {"identity": identity, "bestValidation": best_validation, "model": {k: v.detach().cpu() for k,v in model.state_dict().items()}, "optimizer": optimizer.state_dict(), "scheduler": scheduler.state_dict(), "pythonRng": random.getstate(), "numpyRng": np.random.get_state(), "torchRng": torch.get_rng_state(), "cudaRng": torch.cuda.get_rng_state_all(), "epoch": epoch, "cursor": cursor, "step": step, "order": order}
            temporary = run / "resume.tmp"
            torch.save(payload, temporary)
            os.replace(temporary, run / "resume.pt")
            status("running", epoch=epoch, cursor=cursor, step=step)
        optimizer.zero_grad(set_to_none=True)
        while epoch < epochs:
            while cursor < len(order):
                # A checkpoint boundary includes an entire gradient accumulation group.
                end = min(len(order), cursor + micro * accum)
                group = order[cursor:end]
                batches = [group[i:i + micro] for i in range(0, len(group), micro)]
                loss_value = 0.0
                for indices in batches:
                    batch = collate([items[i] for i in indices], tokenizer.pad_token_id)
                    with torch.autocast("cuda", dtype=torch.bfloat16):
                        logits, act = model(*[batch[key].to("cuda") for key in ("input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype")])
                    logits = logits.float(); mask = batch["marker_mask"].to("cuda")
                    target = batch["target"].to("cuda"); k = mask.sum(-1, keepdim=True).float()
                    sigma = 0.4 + (0.1 - 0.4) * epoch / max(1, epochs - 1)
                    eps = torch.randn((4,) + logits.shape, device="cuda") * sigma * mask
                    eps = (eps - eps.sum(-1, keepdim=True) / k) * mask
                    z = logits.detach().unsqueeze(0) + eps
                    q = torch.softmax(z.masked_fill(~mask, -1e4), -1)
                    with torch.no_grad():
                        reward = proper_reward(q, target.unsqueeze(0), batch["qtype"].to("cuda"), mask, w_sph=0.75, w_rps=1.0)
                        advantage = reward - reward.mean(0, keepdim=True)
                        advantage /= advantage.std() + 1e-6
                    logp = -(((z - logits.unsqueeze(0)) ** 2) * mask).sum(-1) / (2 * sigma ** 2)
                    ce = -(target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1)).sum(-1).mean()
                    loss = (-(advantage * logp).mean() + ce + 0.0 * act.sum()) / len(batches)
                    if not torch.isfinite(loss):
                        raise ValueError("Non-finite training loss")
                    loss.backward(); loss_value += float(loss.detach())
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step(); scheduler.step(); optimizer.zero_grad(set_to_none=True)
                cursor = end; step += 1
                if step % config.get("checkpointEverySteps", 1) == 0 or (run / "cancel.request").exists() or step == config.get("pauseAfterStep"):
                    save_resume()
                status("running", epoch=epoch, cursor=cursor, step=step)
                with (run / "progress.jsonl").open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps({"epoch": epoch, "cursor": cursor, "step": step, "loss": loss_value}) + "\n")
                if (run / "cancel.request").exists() or step == config.get("pauseAfterStep") and not args.resume:
                    status("cancelled", epoch=epoch, cursor=cursor, step=step, resumable=True)
                    return
            if validation:
                model.eval()
                losses = []
                by_capability = defaultdict(list)
                with torch.no_grad():
                    for item in validation:
                        batch = collate([item], tokenizer.pad_token_id)
                        with torch.autocast("cuda", dtype=torch.bfloat16):
                            logits, _ = model(*[batch[key].to("cuda") for key in ("input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype")])
                        mask = batch["marker_mask"].to("cuda")
                        loss = float(-(batch["target"].to("cuda") * torch.log_softmax(logits.float().masked_fill(~mask, -1e4), -1)).sum(-1).mean())
                        losses.append(loss); by_capability[item["capability"]].append(loss)
                model.train()
                value = sum(losses) / len(losses)
                atomic_json(run / f"validation-epoch-{epoch + 1}.json", {"epoch": epoch + 1, "selectionCriterion": "validation cross entropy; not product qualification", "loss": value, "byCapability": {k: sum(v)/len(v) for k,v in by_capability.items()}})
                if value < best_validation:
                    best_validation = value
                    save_checkpoint(model, tokenizer, cfg, run / "checkpoint_best", meta_note={"run": args.run, "epoch": epoch + 1, "selection": "validation cross entropy", "validationLoss": value})
            epoch += 1; cursor = 0
            if epoch < epochs:
                random.shuffle(order)
            save_resume()
        last = run / "checkpoint_last"
        save_checkpoint(model, tokenizer, cfg, last, meta_note={"method": "RLCD continuation", "identity": identity, "run": args.run, "step": step})
        candidate = run / "checkpoint_best" if validation else last
        actual = sha(candidate / "model.safetensors")
        if actual == initial["sha256"]:
            raise ValueError("Training did not update weights")
        models = registry()
        if args.run in models["models"]:
            raise ValueError("Candidate ID already registered")
        manifest = model_manifest(candidate)
        models["models"][args.run] = {"path": str(candidate.relative_to(ROOT)), "sha256": actual, "artifactManifest": manifest, "artifactDigest": artifact_digest(manifest), "status": "candidate", "parent": config["init"], "dataset": identity, "evaluations": []}
        atomic_json(ROOT / "models/registry.json", models)
        status("completed", epoch=epoch, cursor=cursor, step=step, sha256=actual, parentSha256=initial["sha256"])
    except BaseException as error:
        status("failed", error=f"{type(error).__name__}: {error}", resumable=(run / "resume.pt").exists())
        raise

if __name__ == "__main__":
    main()
