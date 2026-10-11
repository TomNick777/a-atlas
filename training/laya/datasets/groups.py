"""Keep company, source-derived and query-family groups in one split."""
import hashlib

DIMENSIONS = ("companyGroupId", "sourceGroupId", "queryGroupId")

def isolate(tasks):
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
    kept = []
    for task in tasks:
        splits = {assignments[dimension][task[dimension]] for dimension in DIMENSIONS}
        if len(splits) == 1:
            kept.append({**task, "split": splits.pop()})
    validate(kept)
    return kept

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
