# Historical source and replay

`source-scripts/` preserves the historical Python sources for provenance. These
files are archived sources, not registered runtime or training entry points.
The root compatibility entries refuse direct historical training/building;
`scripts/laya_server.py` delegates to the registered service without latest/hub
selection. `train_laya.py` here exports the original batch/checkpoint helpers
used by the unified trainer and refuses execution as a trainer.

Replay migrated inputs through `datasets/from_legacy.py`, seal the source
manifest, then use `atlas_runtime.py data --mode legacy --manifest ...` and a
unique named training run. Replay preserves historical prompt, teacher,
soft-target and profile identities. Historical scores and engineering runs do
not qualify a candidate against the merged product contracts.
