import csv

# 데이터 파일 경로 (code 폴더에서 실행한다고 가정)
CSV_PATH = "../data/seoul-apt-latest.csv"

# 실제 파일의 컬럼(영어) <-> 워크북 설명(한글) 매핑
#   gu     = 자치구명
#   dong   = 법정동명
#   complex= 건물명
#   contract_date = 계약일
#   price  = 물건금액(만원)   ← 단위: 만원
#   area_m2= 건물면적(㎡)
#   floor  = 층
#   deal_type = 거래 종류 (매매/전세/월세)

TARGET_GU = "노원구"

노원구_매매 = []  # 노원구 && 매매 인 행만 모을 리스트

with open(CSV_PATH, "r", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    for row in reader:
        # 노원구이고, 거래 종류가 '매매'인 행만 고른다
        if row["gu"] == TARGET_GU and row["deal_type"] == "매매":
            노원구_매매.append(row)

# 1. 가장 비싼 아파트 찾기 (price = 물건금액, 단위 만원)
가장_비싼 = max(노원구_매매, key=lambda r: int(r["price"]))

price_만원 = int(가장_비싼["price"])
price_억 = round(price_만원 / 10000, 1)   # 만원 -> 억, 소수점 1자리 반올림

# 2. 몇 건인지 세기
건수 = len(노원구_매매)

# 결과 출력
print(f"[{TARGET_GU}] 아파트 매매 분석")
print(f"가장 비싼 아파트: {가장_비싼['complex']} ({가장_비싼['dong']})")
print(f"  거래가: {price_억}억  (원본 {price_만원}만원)")
print(f"  전용면적 {가장_비싼['area_m2']}㎡, {가장_비싼['floor']}층, 계약일 {가장_비싼['contract_date']}")
print(f"거래 건수: {건수}건")
