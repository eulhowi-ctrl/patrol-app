#!/usr/bin/env python3
"""소매/바지 길이 2단계 분류기용 크롭 데이터셋 생성 (DeepFashion2 기반).

DeepFashion2 category_id (validation.zip 안 validation/annos/*.json):
  1 short sleeve top, 2 long sleeve top, 3 short sleeve outwear,
  4 long sleeve outwear, 5 vest, 6 sling, 7 shorts, 8 trousers, 9 skirt,
  10 short sleeve dress, 11 long sleeve dress, 12 vest dress, 13 sling dress

zip 전체(3만 장 이상)를 디스크에 풀지 않고, 필요한 카테고리 이미지만
zip에서 직접 읽어 크롭 후 저장 — 디스크/시간 절약.

출력(ImageFolder 포맷):
  training/sleeve_crops/{train,val,test}/{0,1}/*.jpg   0=short_sleeve 1=long_sleeve
  training/pants_crops/{train,val,test}/{0,1}/*.jpg    0=short_pants  1=long_pants
"""
from __future__ import annotations

import io
import json
import random
import shutil
import zipfile
from pathlib import Path

from PIL import Image

ZIP_PATH = Path(__file__).parent / "raw_datasets" / "deepfashion2" / "validation.zip"
SLEEVE_OUT = Path(__file__).parent / "sleeve_crops"
PANTS_OUT = Path(__file__).parent / "pants_crops"
SEED = 42
MAX_PER_CLASS = 1500  # 클래스당 최대 이미지 수 (균형 + 처리시간 제한)

SLEEVE_MAP = {1: 0, 3: 0, 10: 0, 2: 1, 4: 1, 11: 1}  # short=0, long=1
PANTS_MAP = {7: 0, 8: 1}  # short=0(shorts), long=1(trousers)


def _split_for(rng: random.Random) -> str:
    r = rng.random()
    if r < 0.8:
        return "train"
    if r < 0.9:
        return "val"
    return "test"


def _reset(out_dir: Path):
    if out_dir.exists():
        shutil.rmtree(out_dir)


def build():
    rng = random.Random(SEED)
    _reset(SLEEVE_OUT)
    _reset(PANTS_OUT)
    counts = {"sleeve": {0: 0, 1: 0}, "pants": {0: 0, 1: 0}}

    with zipfile.ZipFile(ZIP_PATH) as z:
        anno_names = [n for n in z.namelist() if n.startswith("validation/annos/") and n.endswith(".json")]
        rng.shuffle(anno_names)  # 앞에서부터 순서대로 훑으면 편향될 수 있어 섞음

        for anno_name in anno_names:
            if all(counts[t][c] >= MAX_PER_CLASS for t in counts for c in (0, 1)):
                break
            stem = Path(anno_name).stem  # 예: 013769
            img_name = f"validation/image/{stem}.jpg"
            try:
                with z.open(anno_name) as f:
                    data = json.load(f)
            except Exception:
                continue

            items = [v for k, v in data.items() if k.startswith("item")]
            if not items:
                continue

            img_bytes = None
            for item in items:
                cat = item.get("category_id")
                target = None
                out_dir = None
                if cat in SLEEVE_MAP:
                    task, target, out_dir = "sleeve", SLEEVE_MAP[cat], SLEEVE_OUT
                elif cat in PANTS_MAP:
                    task, target, out_dir = "pants", PANTS_MAP[cat], PANTS_OUT
                else:
                    continue
                if counts[task][target] >= MAX_PER_CLASS:
                    continue
                if img_bytes is None:
                    try:
                        img_bytes = z.read(img_name)
                    except KeyError:
                        break
                try:
                    img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
                except Exception:
                    break
                x0, y0, x1, y1 = item["bounding_box"]
                if x1 - x0 < 20 or y1 - y0 < 20:
                    continue
                crop = img.crop((x0, y0, x1, y1))
                split = _split_for(rng)
                d = out_dir / split / str(target)
                d.mkdir(parents=True, exist_ok=True)
                counts[task][target] += 1
                crop.save(d / f"df2_{stem}_{counts[task][target]}.jpg", quality=90)

    for task, out_dir in (("sleeve", SLEEVE_OUT), ("pants", PANTS_OUT)):
        for split in ("train", "val", "test"):
            for label in ("0", "1"):
                p = out_dir / split / label
                n = len(list(p.glob("*.jpg"))) if p.exists() else 0
                print(f"{task}/{split}/{label}: {n}장")
    print("완료:", SLEEVE_OUT, PANTS_OUT)


if __name__ == "__main__":
    build()
