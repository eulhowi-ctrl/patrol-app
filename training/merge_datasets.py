#!/usr/bin/env python3
"""여러 공개 데이터셋을 하나의 YOLO 학습셋으로 병합.

출처 (모두 training/raw_datasets/에 huggingface_hub로 받아둔 것):
- HB1204/PPE_Detection (CC-BY-4.0): 헬멧/조끼/보안경 미착용 (YOLO 포맷, train/valid/test 있음)
- hmnshudhmn24/face-mask-detection (라이선스 미명시 — 내부용으로만 사용): 마스크 미착용
  (Pascal VOC XML, split 없음 → 자체 분할)
- Simuletic/CCTV-Smoke-Fire-Emergency-Detection-Dataset (CC-BY-NC-4.0, 비상업 — 내부용 확인됨):
  화재/연기 (YOLO 포맷, split 없음 → 자체 분할)
- Simuletic/CCTV_Incident_Dataset_Fall_Lying_Down_Detection (CC-BY-4.0): 쓰러짐
  (YOLO-pose 포맷 — bbox 4개 값만 쓰고 keypoint는 버림, split 없음 → 자체 분할)
- Voxel51/hard-hat-detection (CC0-1.0): 헬멧 미착용(no_helmet) 보강용.
  FiftyOne 포맷(samples.json, bounding_box=[x,y,w,h] 상대좌표 0~1, 좌상단 기준),
  "head"(맨머리=미착용)만 사용, "helmet"(착용)/"person"(모호)은 제외.
  ※ njvisionpower/SHWD는 GitHub 저장소에 데모 이미지만 있고 실제 라벨 데이터는
  Baidu/Google Drive 외부 링크로만 제공되어(프로그래밍 다운로드 불가) 제외함.

최종 클래스(순서가 web/src/lib/labels.ts의 DETECTION_LABELS와 반드시 일치해야 함):
  0 no_helmet, 1 no_vest, 2 no_safety_glasses, 3 no_mask, 4 fire_smoke, 5 man_down

제외: 안전그네/안전화 미착용(공개 데이터셋 없음), 위험지역 진입(시각적 클래스가 아님),
소매/바지 길이(별도 2단계 분류기 — train_clothing_classifier.py 참고).
"""
from __future__ import annotations

import json
import random
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path

RAW = Path(__file__).parent / "raw_datasets"
OUT = Path(__file__).parent / "merged_yolo"
SEED = 42

TARGET_CLASSES = [
    "no_helmet",
    "no_vest",
    "no_safety_glasses",
    "no_mask",
    "fire_smoke",
    "man_down",
]
NO_HELMET, NO_VEST, NO_GLASSES, NO_MASK, FIRE_SMOKE, MAN_DOWN = range(6)


def _reset_out():
    if OUT.exists():
        shutil.rmtree(OUT)
    for split in ("train", "val", "test"):
        (OUT / split / "images").mkdir(parents=True, exist_ok=True)
        (OUT / split / "labels").mkdir(parents=True, exist_ok=True)


def _write_pair(split: str, src_img: Path, prefix: str, lines: list[str]) -> None:
    """이미지 복사 + YOLO 라벨(빈 리스트여도 파일은 생성 — 네거티브 예시로 유효)."""
    dst_name = f"{prefix}_{src_img.stem}{src_img.suffix.lower()}"
    shutil.copy2(src_img, OUT / split / "images" / dst_name)
    label_path = OUT / split / "labels" / f"{prefix}_{src_img.stem}.txt"
    label_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def _random_split(items: list, train=0.8, val=0.1) -> dict:
    rng = random.Random(SEED)
    items = list(items)
    rng.shuffle(items)
    n = len(items)
    n_train = int(n * train)
    n_val = int(n * val)
    return {
        "train": items[:n_train],
        "val": items[n_train:n_train + n_val],
        "test": items[n_train + n_val:],
    }


# ---------------------------------------------------------------------------
# 1) HB1204/PPE_Detection — 이미 train/valid/test 분할되어 있음, YOLO txt 그대로 remap
# ---------------------------------------------------------------------------
def convert_ppe():
    base = RAW / "PPE_Detection"
    # data.yaml names 순서 기준 (index -> label)
    remap = {6: NO_HELMET, 7: NO_VEST, 5: NO_GLASSES}  # NO-Hardhat, NO-Safety Vest, NO-Goggles
    split_dirs = {"train": "train", "val": "valid", "test": "test"}
    counts = {c: 0 for c in TARGET_CLASSES}
    for out_split, src_split in split_dirs.items():
        img_dir = base / src_split / "images"
        lbl_dir = base / src_split / "labels"
        if not img_dir.exists():
            continue
        for img in sorted(img_dir.iterdir()):
            if img.suffix.lower() not in (".jpg", ".jpeg", ".png"):
                continue
            lbl = lbl_dir / f"{img.stem}.txt"
            lines = []
            if lbl.exists():
                for line in lbl.read_text().splitlines():
                    parts = line.split()
                    if not parts:
                        continue
                    cls = int(parts[0])
                    if cls in remap:
                        target = remap[cls]
                        lines.append(f"{target} {' '.join(parts[1:5])}")
                        counts[TARGET_CLASSES[target]] += 1
            _write_pair(out_split, img, "ppe", lines)
    print("PPE_Detection ->", counts)


# ---------------------------------------------------------------------------
# 2) face-mask-detection — Pascal VOC XML, 분할 없음 → 자체 80/10/10 분할
# ---------------------------------------------------------------------------
def convert_mask():
    base = RAW / "face-mask-detection"
    img_dir = base / "images"
    ann_dir = base / "annotations"
    remap = {"without_mask": NO_MASK, "mask_weared_incorrect": NO_MASK}  # with_mask는 제외
    images = sorted(img_dir.glob("*.png"))
    splits = _random_split(images)
    counts = {c: 0 for c in TARGET_CLASSES}
    for split, imgs in splits.items():
        for img in imgs:
            xml_path = ann_dir / f"{img.stem}.xml"
            lines = []
            if xml_path.exists():
                root = ET.parse(xml_path).getroot()
                size = root.find("size")
                w = int(size.find("width").text)
                h = int(size.find("height").text)
                for obj in root.findall("object"):
                    name = obj.find("name").text
                    if name not in remap:
                        continue
                    target = remap[name]
                    box = obj.find("bndbox")
                    xmin, ymin = int(box.find("xmin").text), int(box.find("ymin").text)
                    xmax, ymax = int(box.find("xmax").text), int(box.find("ymax").text)
                    cx, cy = (xmin + xmax) / 2 / w, (ymin + ymax) / 2 / h
                    bw, bh = (xmax - xmin) / w, (ymax - ymin) / h
                    lines.append(f"{target} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
                    counts[TARGET_CLASSES[target]] += 1
            _write_pair(split, img, "mask", lines)
    print("face-mask-detection ->", counts)


# ---------------------------------------------------------------------------
# 3) CCTV 화재/연기 — YOLO txt, 분할 없음 → 자체 80/10/10 분할
# ---------------------------------------------------------------------------
def convert_fire():
    base = RAW / "CCTV-Smoke-Fire-Emergency-Detection-Dataset" / "CCTV_Fire_Smoke_Emergency_Detection_Dataset"
    img_dir = base / "images"
    lbl_dir = base / "labels"
    images = sorted(p for p in img_dir.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    splits = _random_split(images)
    counts = {c: 0 for c in TARGET_CLASSES}
    for split, imgs in splits.items():
        for img in imgs:
            lbl = lbl_dir / f"{img.stem}.txt"
            lines = []
            if lbl.exists():
                for line in lbl.read_text().splitlines():
                    parts = line.split()
                    if not parts:
                        continue
                    # fire(0)/smoke(1) 둘 다 fire_smoke로 합침
                    lines.append(f"{FIRE_SMOKE} {' '.join(parts[1:5])}")
                    counts[TARGET_CLASSES[FIRE_SMOKE]] += 1
            _write_pair(split, img, "fire", lines)
    print("fire/smoke ->", counts)


# ---------------------------------------------------------------------------
# 4) 쓰러짐(laying) — YOLO-pose 포맷, bbox 4개 값만 사용, standing은 제외
#    분할 없음 → 자체 80/10/10 분할
# ---------------------------------------------------------------------------
def convert_fall():
    base = RAW / "CCTV_Incident_Dataset_Fall_Lying_Down_Detection" / "laying_dataset"
    img_dir = base / "images"
    lbl_dir = base / "labels"
    images = sorted(p for p in img_dir.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    splits = _random_split(images)
    counts = {c: 0 for c in TARGET_CLASSES}
    for split, imgs in splits.items():
        for img in imgs:
            lbl = lbl_dir / f"{img.stem}.txt"
            lines = []
            if lbl.exists():
                for line in lbl.read_text().splitlines():
                    parts = line.split()
                    if not parts:
                        continue
                    cls = int(parts[0])
                    if cls != 0:  # 0=laying만 사용, 1=standing 제외
                        continue
                    lines.append(f"{MAN_DOWN} {' '.join(parts[1:5])}")  # bbox 4개만, keypoint 버림
                    counts[TARGET_CLASSES[MAN_DOWN]] += 1
            _write_pair(split, img, "fall", lines)
    print("man_down ->", counts)


# ---------------------------------------------------------------------------
# 5) Voxel51 hard-hat-detection — FiftyOne samples.json, "head"만 no_helmet으로
#    사용(맨머리=미착용). 분할 없음 → 자체 80/10/10 분할
# ---------------------------------------------------------------------------
def convert_hardhat():
    base = RAW / "hard-hat-detection"
    samples_path = base / "samples.json"
    if not samples_path.exists():
        print("hard-hat-detection: samples.json 없음 — 건너뜀")
        return
    samples = json.loads(samples_path.read_text(encoding="utf-8"))["samples"]
    items = [s for s in samples if (base / s["filepath"]).exists()]
    splits = _random_split(items)
    counts = {c: 0 for c in TARGET_CLASSES}
    for split, split_items in splits.items():
        for sample in split_items:
            img = base / sample["filepath"]
            lines = []
            for det in (sample.get("ground_truth") or {}).get("detections") or []:
                if det.get("label") != "head":  # helmet(착용)/person(모호)은 제외
                    continue
                x, y, w, h = det["bounding_box"]
                cx, cy = min(max(x + w / 2, 0.0), 1.0), min(max(y + h / 2, 0.0), 1.0)
                bw, bh = min(max(w, 0.0), 1.0), min(max(h, 0.0), 1.0)
                lines.append(f"{NO_HELMET} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
                counts[TARGET_CLASSES[NO_HELMET]] += 1
            _write_pair(split, img, "hardhat", lines)
    print("hard-hat-detection ->", counts)


# ---------------------------------------------------------------------------
# 6) SHEL5K — 헬멧 미착용(Head) 보강용. YOLO txt 포맷, train/val 분할 있음
#    클래스 인덱싱: Helmet(0), Head(1)=맨머리=미착용만 사용
# ---------------------------------------------------------------------------
def convert_shel5k():
    base = RAW / "SHEL5K"
    if not base.exists():
        print("SHEL5K: 디렉토리 없음 — 건너뜀")
        return

    # 일반적인 SHEL5K 구조: train/, val/ 또는 images/, annotations/
    splits_to_check = [
        ("train", base / "train" / "images", base / "train" / "labels"),
        ("val", base / "val" / "images", base / "val" / "labels"),
        ("val", base / "images", base / "labels"),  # 대체 구조
    ]

    counts = {c: 0 for c in TARGET_CLASSES}

    for out_split, img_dir, lbl_dir in splits_to_check:
        if not img_dir.exists() or not lbl_dir.exists():
            continue

        for img in sorted(img_dir.iterdir()):
            if img.suffix.lower() not in (".jpg", ".jpeg", ".png"):
                continue

            lbl = lbl_dir / f"{img.stem}.txt"
            lines = []

            if lbl.exists():
                for line in lbl.read_text().splitlines():
                    parts = line.split()
                    if not parts:
                        continue
                    cls = int(parts[0])
                    # cls=1: Head (맨머리=미착용), cls=0: Helmet(착용) 무시
                    if cls == 1:  # Head = no_helmet
                        lines.append(f"{NO_HELMET} {' '.join(parts[1:5])}")
                        counts[TARGET_CLASSES[NO_HELMET]] += 1

            _write_pair(out_split, img, "shel5k", lines)

    if counts[TARGET_CLASSES[NO_HELMET]] > 0:
        print("SHEL5K ->", counts)
    else:
        print("SHEL5K: no_helmet 샘플 없음 — 건너뜀")


def write_data_yaml():
    names = "\n".join(f"  {i}: {name}" for i, name in enumerate(TARGET_CLASSES))
    (OUT / "data.yaml").write_text(
        f"path: {OUT.resolve()}\n"
        "train: train/images\n"
        "val: val/images\n"
        "test: test/images\n\n"
        f"nc: {len(TARGET_CLASSES)}\n"
        f"names:\n{names}\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    _reset_out()
    convert_ppe()
    convert_mask()
    convert_fire()
    convert_fall()
    convert_hardhat()
    convert_shel5k()  # ← SHEL5K 추가 (다운로드 후 사용)
    write_data_yaml()
    for split in ("train", "val", "test"):
        n = len(list((OUT / split / "images").iterdir()))
        print(f"{split}: {n}장")
    print("완료:", OUT / "data.yaml")
