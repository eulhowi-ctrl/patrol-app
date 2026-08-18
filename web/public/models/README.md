# 모델 파일 배치 위치

이 폴더에 학습된 객체 감지 모델을 `detector.onnx` 이름으로 넣는다.

- 클래스 구성(순서 포함)은 `web/src/lib/labels.ts`의 `DETECTION_LABELS`와 반드시 일치해야 한다:
  `no_helmet, no_vest, no_safety_glasses, no_mask, fire_smoke, man_down` (6클래스).
  `training/merge_datasets.py`의 `TARGET_CLASSES`도 같은 순서로 유지할 것.
- YOLOv8 Nano를 위 6개 클래스로 파인튜닝 후 `.onnx`로 export한다 (`training/train.py` 참고).
  INT8/FP16 양자화는 선택 사항 — 모바일 추론 속도가 부족하면 추가 적용.
- 이 저장소는 모델 가중치 파일 자체를 포함하지 않는다 (용량 및 데이터셋 라이선스 문제).
  `web/src/workers/detection.worker.ts`는 이 경로(`NEXT_PUBLIC_MODEL_PATH`)에서 모델을 로드하도록 작성되어 있다.
- 반팔/반바지(소매·바지 길이) 판정은 이 YOLO 모델이 아니라 2단계 보조 분류기가 담당한다
  (`training/train_clothing_classifier.py`, 결과 `clothing.onnx`) — person 크롭 이미지를 입력받는다.
