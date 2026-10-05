# Kaggle 备用训练包(A 股 Laya 微调)

本机 RTX 4060 已能完成训练(`scripts/train_laya.py`,主路径)。这个包是
2×T4 DDP 备用方案,训练逻辑与官方 notebook(`laya_finetune_typed_decisions_2xT4_kaggle.ipynb`)
一致,仅把数据换成 A 股训练项(`data/train/train_items.pt`,纯 dict 可直接 torch.load)。

## 步骤

1. kaggle.com → New Dataset:上传 `data/train/train_items.pt` 和 `train_laya_kaggle.py`。
2. New Notebook → Settings → Accelerator: **GPU T4 x2**,Internet: **On**。
3. 第一个 cell:

```bash
!pip install -q -U "laya>=0.3.5" safetensors
```

4. 把数据集挂载后(Add Input),第二个 cell:

```python
!cp -r /kaggle/input/<your-dataset>/* /kaggle/working/
!torchrun --standalone --nproc_per_node=2 /kaggle/working/train_laya_kaggle.py \
    /kaggle/working/train_items.pt /kaggle/working/laya_a_share
```

5. 运行完(约 10 分钟)下载 `/kaggle/working/laya_a_share/checkpoint_last/`,
   放回本仓库 `models/a-share-laya/`。

## 注意

- Kaggle 上没有冻结 VAL 在线选优(脚本按官方做法存 checkpoint_last);
  拷回本地后用 `scripts/evaluate_laya.py` 在 VAL/TEST 上评测,
  如果不如本地产物,以本地产物为准。
- `checkpoint_last` 的温度未拟合(=1.0)。本地产物的温度是训练后拟合的,
  两者 `rl_agent_config.json` 里的 `temperature` 不同属正常。
- 数据与种子与本机训练完全一致(seed 42 / 数据 sha 见 data/train/manifest.json)。
