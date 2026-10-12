"""Keep company, source-derived and query-family groups in one split."""
import hashlib
from collections import Counter

DIMENSIONS = ("companyGroupId", "sourceGroupId", "queryGroupId")

def isolate(tasks, balanced=False):
    parents = {}
    def find(key):
        parents.setdefault(key, key)
        if parents[key] != key:
            parents[key] = find(parents[key])
        return parents[key]
    for task in tasks:
        left, right = find(("company", task["companyGroupId"])), find(("source", task["sourceGroupId"]))
        if left != right:
            parents[max(left, right)] = min(left, right)
    components = sorted({find(key) for key in parents}, key=lambda key: hashlib.sha256(repr(key).encode()).hexdigest())
    split_of = lambda i: "validation" if i % 10 == 0 else "blind" if i % 10 == 1 else "train"
    component_splits = {key: split_of(i) for i, key in enumerate(components)}
    assignments = {dimension: {task[dimension]: component_splits[find((kind, task[dimension]))] for task in tasks} for dimension, kind in (("companyGroupId", "company"), ("sourceGroupId", "source"))}
    owners, counts = {}, {}
    for task in tasks:
        query = task["queryGroupId"]
        owners.setdefault(query, set()).add(find(("company", task["companyGroupId"])))
        counts[query] = counts.get(query, 0) + 1
    shared = sorted((key for key in owners if len(owners[key]) > 1), key=lambda key: (-counts[key], hashlib.sha256(key.encode()).hexdigest()))
    assignments["queryGroupId"] = {key: split_of(i) for i, key in enumerate(shared)}
    for key, owner in owners.items():
        if len(owner) == 1:
            assignments["queryGroupId"][key] = component_splits[next(iter(owner))]
    if balanced:
        features = {(task["capability"], task["label"]) for task in tasks}
        splits = ("train", "validation", "blind")
        def score(query_splits):
            counts = Counter()
            for task in tasks:
                split = assignments["companyGroupId"][task["companyGroupId"]]
                if query_splits[task["queryGroupId"]] == split:
                    counts[(split, task["capability"], task["label"])] += 1
            bins = [counts[(split, *feature)] for split in splits for feature in features]
            return (sum(n > 0 for n in bins), sum(min(n, 3) for n in bins), sum(bins))
        # Stratify only by reviewed training labels. Never read acceptance cases.
        best, best_score = None, None
        for seed in range(12):
            candidate = dict(assignments["queryGroupId"])
            for key in shared:
                candidate[key] = splits[int(hashlib.sha256(f"{seed}:{key}".encode()).hexdigest()[:8], 16) % 3]
            for _ in range(20):
                changed = False
                for key in shared:
                    previous = candidate[key]
                    choices = []
                    for split in splits:
                        candidate[key] = split
                        choices.append((score(candidate), split))
                    candidate[key] = max(choices, key=lambda item: (item[0], item[1] == previous))[1]
                    changed |= candidate[key] != previous
                if not changed:
                    break
            result_score = score(candidate)
            if best_score is None or result_score > best_score:
                best, best_score = candidate, result_score
        assignments["queryGroupId"] = best
    kept = []
    for task in tasks:
        splits = {assignments[dimension][task[dimension]] for dimension in DIMENSIONS}
        if len(splits) == 1:
            kept.append({**task, "split": splits.pop()})
    validate(kept)
    return kept

def validate_coverage(tasks):
    required = {"semantic_match", "semantic_relation", "semantic_comparison", "evidence_explanation"}
    for split in ("train", "validation", "blind"):
        for capability in required:
            labels = {task["label"] for task in tasks if task["split"] == split and task["capability"] == capability}
            if not {0, 3} <= labels:
                raise ValueError(f"Product dataset needs positive and negative labels: {split}/{capability}")

def validate(tasks):
    seen = {}
    for task in tasks:
        if task["split"] not in ("train", "validation", "blind"):
            raise ValueError("Invalid dataset split")
        for dimension in DIMENSIONS:
            value = task.get(dimension)
            if not isinstance(value, str) or not value:
                raise ValueError(f"Corpus task requires {dimension}")
            key = (dimension, value)
            if key in seen and seen[key] != task["split"]:
                raise ValueError(f"Dataset group leakage: {dimension}")
            seen[key] = task["split"]
