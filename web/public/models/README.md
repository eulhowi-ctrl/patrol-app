# 모델 파일 배치 위치

이 폴더의 5개 `.onnx` 파일은 `web/.gitignore`의 `*.onnx` 규칙에서 예외 처리되어
저장소에 커밋되어 있다(합쳐서 13MB 정도라 Cloudflare Pages가 git에서 직접 빌드하는
데 지장 없음). 모델을 새로 학습해 교체할 때는 파일명을 그대로 유지할 것 —
`detection.worker.ts`가 이 이름으로 로드한다.

## detector.onnx — 1단계 위반 탐지 (YOLOv8 Nano, 직접 학습)
- 클래스 구성(순서 포함)은 `web/src/lib/labels.ts`의 `DETECTION_LABELS`와 반드시 일치해야 한다:
  `no_helmet, no_vest, no_safety_glasses, no_mask, fire_smoke, man_down` (6클래스).
  `training/merge_datasets.py`의 `TARGET_CLASSES`도 같은 순서로 유지할 것.
- 학습: `training/merge_datasets.py`로 공개 데이터셋 병합 → `training/train.py`로
  파인튜닝(imgsz=256, CPU) → ONNX export.
- INT8/FP16 양자화는 선택 사항 — 모바일 추론 속도가 부족하면 추가 적용.

## person.onnx — 사람 위치 탐지 (COCO 사전학습 YOLOv8n, 재학습 없이 그대로 사용)
- detector.onnx에는 person 클래스가 없어서, 2단계 분류기(아래)에 넣을 사람 크롭을
  만들기 위해 COCO 80클래스 중 person(class 0)만 사용하는 용도로 별도로 둠.
- `yolov8n.pt`(ultralytics 기본 제공)를 `imgsz=256`으로 그대로 export한 파일 —
  파인튜닝 안 함.

## harness.onnx / sleeve.onnx / pants.onnx — 2단계 보조 분류기 (MobileNetV3-Small)
- 안전그네 착용, 소매 길이(긴팔/반팔), 바지 길이(긴바지/반바지)를 이진 분류.
- "물체"가 아니라 사람의 옷차림 상태라 YOLO 클래스로 넣지 않고 분리함.
- `detection.worker.ts`가 person.onnx로 찾은 사람 박스를 크롭해 입력으로 준다
  (화면에 여러 명이 있으면 가장 크게 잡힌 사람 한 명만 판정).
- 학습: `training/build_harness_crops.py` / `build_clothing_crops.py`로 크롭
  데이터셋 생성 → `training/train_classifier.py --data-dir ... --out-name ...`로
  학습 → ONNX export까지 스크립트 안에서 자동 수행.
- 각 모델의 클래스 인덱스 규약(폴더명 "0"/"1" → ImageFolder 인덱스):
  harness 0=미착용 1=착용, sleeve 0=반팔 1=긴팔, pants 0=반바지 1=긴바지.

## 미포함 항목
- 위험지역(danger zone) 진입: 현장마다 다른 좌표라 시각적으로 학습 불가능한 속성.
  person 탐지 + 앱에서 그린 구역과의 좌표 겹침 판정으로 별도 구현 필요.
- 안전그네·안전화: 최초엔 안전화도 계획했으나 공개 데이터셋(부정 라벨 포함)을
  찾지 못해 보류. 안전그네는 위 harness.onnx로 대체 반영됨.
