#!/usr/bin/env python3
"""
VetClinic Demo Seed v3
======================
• Кассовая стоимость = ровно 60% от цены
• Все позиции приёма привязаны к каталогу (item_id обязателен)
• Нет свободного ввода — только каталожные товары

Запуск:
    1. del data\\vet.db          (Windows)
       rm -f data/vet.db        (Linux/Mac)
    2. go run ./backend/
    3. python3 scripts/seed.py
"""

import json, random, sys
from datetime import date, datetime, timedelta
import urllib.request, urllib.error

BASE_URL = "http://localhost:8080"
random.seed(7)   # другой seed → другие случайные значения

# ── HTTP ──────────────────────────────────────────────────────────────────────

def api(method, path, data=None):
    url = BASE_URL + path
    body = json.dumps(data, ensure_ascii=False).encode("utf-8") if data else None
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json; charset=utf-8",
                 "X-Bypass-Local": "1"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            r = json.loads(resp.read().decode("utf-8"))
            return r.get("data") if r.get("status") == "ok" else None
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:    msg = json.loads(raw).get("message", raw[:120])
        except: msg = raw[:120]
        print(f"    ✗ HTTP {e.code}: {msg}")
        return None
    except Exception as ex:
        print(f"    ✗ {ex}")
        return None

def check_server():
    try:
        with urllib.request.urlopen(BASE_URL + "/health", timeout=5) as r:
            return r.status == 200
    except Exception:
        return False

def rdate(min_d=1, max_d=365):
    return (date.today() - timedelta(days=random.randint(min_d, max_d))).isoformat()

def rdatetime(min_d=0, max_d=60):
    d = date.today() - timedelta(days=random.randint(min_d, max_d))
    h, m = random.randint(8, 18), random.choice([0, 15, 30, 45])
    return f"{d.isoformat()}T{h:02d}:{m:02d}:00Z"

def cp(price):
    """Кассовая стоимость = ровно 60% от цены, округлённая до 50."""
    raw = round(price * 0.6)
    return max(100, round(raw / 50) * 50)

# ── Справочник ─────────────────────────────────────────────────────────────────

# (name, type, price)  →  cost_price = cp(price)
CATALOG_RAW = [
    # Услуги
    ("Первичный осмотр",               "service",  3000),
    ("Повторный осмотр",               "service",  2000),
    ("Вакцинация комплексная",         "service",  4500),
    ("Стерилизация (кошка)",           "service", 18000),
    ("Кастрация (кот)",                "service", 14000),
    ("УЗИ брюшной полости",            "service",  6000),
    ("Анализ крови общий",             "service",  3500),
    ("Анализ мочи",                    "service",  2500),
    ("Рентгенография (1 проекция)",    "service",  5000),
    ("Чистка зубов ультразвуком",      "service",  9000),
    ("Стрижка когтей",                 "service",  1500),
    ("Груминг кошка",                  "service",  5000),
    ("Груминг собака малая",           "service",  4500),
    ("Груминг собака крупная",         "service",  9000),
    ("Капельница внутривенная",        "service",  3500),
    ("Перевязка",                      "service",  1200),
    ("Удаление зуба",                  "service",  3000),
    ("Микрочипирование",               "service",  4000),
    ("Обработка от паразитов (ванна)", "service",  3000),
    ("Консультация онлайн",            "service",  1500),
    # Препараты
    ("Амоксициллин 250 мг (таб)",      "drug",      850),
    ("Метронидазол 500 мг",            "drug",      650),
    ("Синулокс 250 мг (10 таб)",       "drug",     1400),
    ("Дексаметазон 4 мг/мл",           "drug",      550),
    ("Катозал 10% 100мл",              "drug",      950),
    ("Дронтал плюс (таб)",             "drug",     1600),
    ("Фронтлайн спрей 250мл",          "drug",     3800),
    ("Бравекто 250–500 мг",            "drug",     5500),
    ("Каниквантел плюс",               "drug",      900),
    ("Фуросемид 1%",                   "drug",      450),
    ("Омепразол 20 мг",                "drug",      750),
    ("Витамины Beaphar",               "drug",     2200),
    ("Физраствор NaCl 0.9% 500мл",     "drug",      350),
    ("Цефтриаксон 1 г",                "drug",     1100),
    ("Энрофлоксацин 50 мг/мл",         "drug",     1800),
]

STAFF = [
    {"name": "Ахметова Динара Кайратовна",    "role": "vet",           "phone": "+7 701 234 5678"},
    {"name": "Иванов Сергей Петрович",         "role": "vet",           "phone": "+7 702 345 6789"},
    {"name": "Нурмагамбетов Алибек Муратович", "role": "surgeon",       "phone": "+7 703 456 7890"},
    {"name": "Касымова Жанна Бекова",          "role": "vet_assistant", "phone": "+7 705 567 8901"},
    {"name": "Петрова Ольга Владимировна",     "role": "admin",         "phone": "+7 707 678 9012"},
    {"name": "Сейтжанов Ерлан Маратович",      "role": "vet",           "phone": "+7 708 789 0123"},
    {"name": "Дюсебаева Алина Руслановна",     "role": "groomer",       "phone": "+7 771 890 1234"},
    {"name": "Ким Александр Николаевич",       "role": "vet_assistant", "phone": "+7 776 901 2345"},
]

OWNERS = [
    {"fio": "Ахметов Бауыржан Сейткалиевич",  "phone": "+7 701 111 2233", "iin": "850312300145",
     "address": "г. Алматы, ул. Абая 45, кв. 12"},
    {"fio": "Петрова Наталья Александровна",   "phone": "+7 702 222 3344",
     "address": "г. Алматы, мкр. Алатау д. 23"},
    {"fio": "Нурмуханов Серік Болатович",      "phone": "+7 705 333 4455", "iin": "920617400236"},
    {"fio": "Ли Виктория Сергеевна",           "phone": "+7 707 444 5566",
     "address": "г. Алматы, ул. Достык 120"},
    {"fio": "Смагулов Дамир Кенжебекович",     "phone": "+7 708 555 6677", "iin": "780924500128"},
    {"fio": "Козлова Ирина Петровна",          "phone": "+7 771 666 7788",
     "address": "г. Астана, ул. Кабанбай батыра 15"},
    {"fio": "Байжанов Нурлан Маратович",       "phone": "+7 776 777 8899", "iin": "930101300147"},
    {"fio": "Мусаева Айгерим Бекова",          "phone": "+7 777 888 9900",
     "address": "г. Алматы, ул. Толе би 78"},
    {"fio": "Соколов Андрей Викторович",       "phone": "+7 778 999 0011", "iin": "860715200389"},
    {"fio": "Жакупова Дина Ержановна",         "phone": "+7 700 000 1122",
     "address": "г. Астана, мкр. Нурсая 5"},
    {"fio": "Тлеулин Ермек Сапарович",         "phone": "+7 701 123 4567", "iin": "751230100456"},
    {"fio": "Новикова Светлана Юрьевна",       "phone": "+7 702 234 5678",
     "address": "г. Алматы, ул. Наурызбай батыра 33"},
    {"fio": "Кали Айдана Сейтбековна",         "phone": "+7 705 345 6789", "iin": "950825400512"},
    {"fio": "Морозов Дмитрий Игоревич",        "phone": "+7 707 456 7890",
     "address": "г. Алматы, мкр. Думан 8"},
    {"fio": "Ерболатова Гульмира Асановна",    "phone": "+7 708 567 8901", "iin": "820503300241"},
    {"fio": "Чен Александра Дмитриевна",       "phone": "+7 771 678 9012"},
    {"fio": "Асанов Руслан Бакытбекович",      "phone": "+7 776 789 0123", "iin": "900212400178"},
    {"fio": "Попова Елена Васильевна",         "phone": "+7 777 890 1234",
     "address": "г. Алматы, ул. Жибек жолы 55"},
    {"fio": "Сабитов Канат Мейрамович",        "phone": "+7 778 901 2345", "iin": "870404300367"},
    {"fio": "Захарова Анна Михайловна",        "phone": "+7 700 012 3456",
     "address": "г. Астана, ул. Момышулы 14"},
]

# (owner_idx, name, type, gender, breed, age_yrs, status, death_reason)
PETS = [
    (0,  "Мухтар",   "собака",  "m", "Немецкая овчарка",           5, "active",   None),
    (0,  "Мурка",    "кошка",   "f", "Британская короткошёрстная", 3, "active",   None),
    (1,  "Снежок",   "кошка",   "m", "Персидская",                 7, "active",   None),
    (1,  "Найда",    "собака",  "f", "Дворняга",                   4, "active",   None),
    (2,  "Барсик",   "кошка",   "m", "Шотландская вислоухая",      2, "active",   None),
    (2,  "Рекс",     "собака",  "m", "Ротвейлер",                  6, "active",   None),
    (3,  "Белла",    "собака",  "f", "Лабрадор-ретривер",          3, "active",   None),
    (3,  "Пушок",    "кошка",   "m", "Сибирская",                  5, "active",   None),
    (4,  "Шарик",    "собака",  "m", "Дворняга",                   9, "deceased", "По возрасту"),
    (4,  "Тигр",     "кошка",   "m", "Мейн-кун",                   4, "active",   None),
    (5,  "Луна",     "кошка",   "f", "Русская голубая",            2, "active",   None),
    (5,  "Буся",     "кролик",  "f", "Декоративный",               1, "active",   None),
    (6,  "Макс",     "собака",  "m", "Сибирский хаски",            3, "active",   None),
    (6,  "Нюша",     "кошка",   "f", "Невская маскарадная",        6, "active",   None),
    (7,  "Граф",     "собака",  "m", "Доберман",                   5, "active",   None),
    (7,  "Лиса",     "кошка",   "f", "Абиссинская",                3, "active",   None),
    (8,  "Бонни",    "собака",  "f", "Кокер-спаниель",             2, "active",   None),
    (8,  "Персик",   "кошка",   "m", "Экзотическая",               4, "active",   None),
    (9,  "Дина",     "собака",  "f", "Такса",                      7, "active",   None),
    (9,  "Кеша",     "попугай", "m", "Волнистый",                  5, "active",   None),
    (10, "Арчи",     "собака",  "m", "Боксёр",                     4, "active",   None),
    (10, "Феня",     "кошка",   "f", "Дворовая",                  11, "deceased", "По болезни"),
    (11, "Бисквит",  "кошка",   "m", "Британская",                 1, "active",   None),
    (12, "Джек",     "собака",  "m", "Джек-рассел",                3, "active",   None),
    (13, "Нала",     "кошка",   "f", "Бенгальская",                2, "active",   None),
    (14, "Тобик",    "собака",  "m", "Дворняга",                  10, "active",   None),
    (15, "Зефир",    "кролик",  "m", "Декоративный",               2, "active",   None),
    (16, "Рыжик",    "кошка",   "m", "Дворовая",                   6, "active",   None),
    (17, "Альфа",    "собака",  "f", "Немецкая овчарка",           4, "active",   None),
    (18, "Степан",   "кошка",   "m", "Мейн-кун",                   3, "active",   None),
    (19, "Лаки",     "собака",  "m", "Золотистый ретривер",        2, "active",   None),
]

PET_WEIGHTS = {
    "собака":  (3.0, 45.0), "кошка":  (2.5,  7.0),
    "кролик":  (1.0,  3.5), "попугай":(0.03, 0.1),
}

CONDITIONS  = ["Здоров","Здоров","Здоров","Лёгкое","средней тяжести"]
VISIT_TYPES = ["первичный","первичный","вторичный"]  # 2/3 первичных

DIAGNOSES = [
    "Отит наружный правого уха","Гастроэнтерит острый","Дерматит аллергический",
    "Конъюнктивит гнойный","Ринит вирусный","Мочекаменная болезнь",
    "Ожирение II степени","Зубной камень, гингивит","Инвазия кишечная",
    "Трихофития","Ушиб мягких тканей","Цистит","Панкреатит острый",
    "Пиодермия поверхностная","Блошиный дерматит","Профилактический осмотр",
    "Плановая вакцинация","Анемия железодефицитная","Гельминтоз",
    "Абсцесс подкожный",
]
ANAMNESES = [
    "Снижение аппетита 3 дня, вялость","Расчёсывает уши, трясёт головой",
    "Жидкий стул 2 дня, рвота 1 раз","Зуд кожи, выпадение шерсти",
    "Слезотечение, выделения из глаз","Частое болезненное мочеиспускание",
    "Плановая вакцинация, жалоб нет","Плановый осмотр","Хромает на лапу",
    "Отказ от еды, вздутие живота",
]
TREATMENTS = [
    "Промывание ушного канала, Отибиовет 7 дней",
    "Диета лёгкая 5 дней, Энтеросгель 2 р/д",
    "Антибиотикотерапия 7 дней, местная обработка",
    "Промывание глаз, капли 5 дней",
    "Диета Royal Canin Urinary, обильное питьё",
    "УЗ-чистка зубов, обработка антисептиком",
    "Дронтал плюс однократно, повтор через 14 дней",
    "Покой 7 дней, нестероидные препараты 3 дня",
]
VACCINES = [
    ("Nobivac Tricat Trio",      "MSD Animal Health"),
    ("Мультикан-6",              "Нарвак"),
    ("Nobivac DHPPi + L4",       "MSD Animal Health"),
    ("Рабикан",                  "Нарвак"),
    ("Purevax RCP",              "Boehringer Ingelheim"),
    ("Феловакс-4",               "Fort Dodge"),
]


def main():
    print("=" * 60)
    print("  VetClinic Demo Seed v3 — кассовая 60% от цены")
    print("=" * 60)

    print(f"\n🔌 Проверяем сервер {BASE_URL}...")
    if not check_server():
        print("  ✗ Сервер не отвечает. Запустите: go run ./backend/")
        sys.exit(1)
    print("  ✓ Сервер доступен\n")

    # ── 1. Персонал ──────────────────────────────────────────────────────
    print("👨‍⚕️  Персонал...")
    staff_ids = []
    for s in STAFF:
        r = api("POST", "/staff", {**s, "is_active": True})
        if r:
            staff_ids.append(r["id"])
            print(f"  ✓ {s['name']} [{s['role']}]")
    print(f"  → {len(staff_ids)} сотрудников\n")

    # ── 2. Каталог — кассовая строго 60% ─────────────────────────────────
    print("🛒  Каталог (касса = 60% от цены)...")
    items_db = {}   # id → {id, name, type, price, cost_price}
    for name, itype, price in CATALOG_RAW:
        cost = cp(price)
        assert cost < price, f"cost_price должна быть < price: {name}"
        r = api("POST", "/items", {
            "name": name, "type": itype,
            "price": float(price), "cost_price": float(cost)
        })
        if r:
            items_db[r["id"]] = {
                "id": r["id"], "name": name, "type": itype,
                "price": price, "cost_price": cost
            }
            diff = price - cost
            print(f"  ✓ {name:<40}  цена: {price:>6} ₸  касса: {cost:>5} ₸  "
                  f"наценка: {diff:>5} ₸ ({round(diff/price*100)}%)")
    svc_items  = [v for v in items_db.values() if v["type"] == "service"]
    drug_items = [v for v in items_db.values() if v["type"] == "drug"]
    print(f"\n  → {len(items_db)} позиций "
          f"({len(svc_items)} услуг, {len(drug_items)} препаратов)\n")

    if not items_db:
        print("✗ Каталог не создан — прерываю")
        sys.exit(1)

    # ── 3. Владельцы ──────────────────────────────────────────────────────
    print("👥  Владельцы...")
    owner_ids = []
    for o in OWNERS:
        r = api("POST", "/owners", o)
        if r:
            owner_ids.append(r["id"])
            print(f"  ✓ {o['fio']:40}  {o['phone']}")
    print(f"  → {len(owner_ids)} владельцев\n")

    if not owner_ids:
        print("✗ Владельцы не созданы — прерываю")
        sys.exit(1)

    # ── 4. Питомцы ────────────────────────────────────────────────────────
    print("🐾  Питомцы...")
    pet_list = []   # [(owner_idx, name, pet_id, type, gender)]
    for (oi, name, ptype, gender, breed, age, status, death_reason) in PETS:
        if oi >= len(owner_ids):
            continue
        birth_date = f"{date.today().year - age}-06-15"
        w_min, w_max = PET_WEIGHTS.get(ptype, (1.5, 8.0))
        weight = round(random.uniform(w_min, w_max), 1)
        r = api("POST", "/pets", {
            "owner_id":   owner_ids[oi], "name": name,
            "type":       ptype,         "gender": gender,
            "breed":      breed,         "birth_date": birth_date,
            "weight":     weight,
        })
        if r:
            pid = r["id"]
            pet_list.append((oi, name, pid, ptype, gender))
            print(f"  ✓ {name:<12} {ptype:<9} {weight:>4.1f} кг  — {OWNERS[oi]['fio']}")
            if status == "deceased":
                death_date = rdate(min_d=30, max_d=400)
                api("PUT", f"/pets/{pid}/deceased", {
                    "death_date":   death_date,
                    "death_reason": death_reason,
                })
                print(f"    ☠ умер {death_date}: {death_reason}")
    print(f"  → {len(pet_list)} питомцев\n")

    # ── 5. Приёмы — КАЖДАЯ позиция с item_id из каталога ─────────────────
    print("📅  Приёмы (50 записей, все позиции из каталога)...")
    visit_count = 0

    for i in range(50):
        oi, pet_name, pet_id, ptype, pgender = random.choice(pet_list)
        owner = OWNERS[oi]

        visit_type = random.choice(VISIT_TYPES)

        w_min, w_max = PET_WEIGHTS.get(ptype, (1.5, 8.0))
        animal_weight = round(random.uniform(w_min, w_max), 1)

        # Формируем позиции — ТОЛЬКО из каталога, item_id обязателен
        chosen = []

        # 1 услуга (обязательно)
        svc = random.choice(svc_items)
        chosen.append({
            "item_id":  svc["id"],          # ← привязка к каталогу
            "name":     svc["name"],
            "type":     "service",
            "quantity": 1.0,
            "price":    float(svc["price"]),
        })

        # 1–2 препарата (с вероятностью)
        n_drugs = random.choices([0, 1, 2], weights=[30, 50, 20])[0]
        for _ in range(n_drugs):
            dr = random.choice(drug_items)
            qty = float(random.choice([1, 1, 1, 2, 3]))
            chosen.append({
                "item_id":  dr["id"],        # ← привязка к каталогу
                "name":     dr["name"],
                "type":     "drug",
                "quantity": qty,
                "price":    float(dr["price"]),
            })

        body = {
            "owner": {
                "id":    owner_ids[oi],
                "fio":   owner["fio"],
                "phone": owner["phone"],
            },
            "pet": {
                "id":       pet_id,
                "name":     pet_name,
                "type":     ptype,
                "gender":   pgender,
                "owner_id": owner_ids[oi],
            },
            "visit": {
                "date":               rdatetime(min_d=0, max_d=60),
                "visit_type":         visit_type,
                "animal_weight":      animal_weight,
                "patient_condition":  random.choice(CONDITIONS),
                "anamnesis":          random.choice(ANAMNESES),
                "diagnosis":          random.choice(DIAGNOSES),
                "treatment":          random.choice(TREATMENTS),
                "notes":              random.choice(["", "", "Повторный осмотр через 2 нед."]),
            },
            "items": chosen,
        }

        r = api("POST", "/visits/full", body)
        if r:
            visit_count += 1
            total = sum(it["price"] * it["quantity"] for it in chosen)
            cash  = sum(items_db[it["item_id"]]["cost_price"] * it["quantity"]
                        for it in chosen)
            diff  = total - cash
            vt = "П" if visit_type == "первичный" else "В"
            items_str = "+".join(
                ("У" if c["type"]=="service" else "П") + str(int(c["quantity"]))
                for c in chosen
            )
            print(f"  ✓ [{i+1:02d}][{vt}] {pet_name:<10} {ptype[:3]} "
                  f"{animal_weight:>4.1f}кг │{items_str:<8}│ "
                  f"Сумма:{total:>6.0f}₸ Касса:{cash:>5.0f}₸ Δ:{diff:>5.0f}₸")
        else:
            print(f"  · [{i+1:02d}] пропуск")

    print(f"  → {visit_count} приёмов (каждая позиция привязана к каталогу)\n")

    # ── 6. Вакцинации ─────────────────────────────────────────────────────
    print("💉  Вакцинации (35 записей)...")
    vacc_count = 0
    for i in range(35):
        oi, pet_name, pet_id, _, _ = random.choice(pet_list)
        vacc_name, manufacturer = random.choice(VACCINES)
        admin_date = rdate(min_d=10, max_d=400)
        next_due   = (datetime.strptime(admin_date,"%Y-%m-%d") + timedelta(days=365)).strftime("%Y-%m-%d")
        data = {
            "pet_id":         pet_id,
            "vaccine_name":   vacc_name,
            "manufacturer":   manufacturer,
            "batch_number":   f"B{random.randint(100000, 999999)}",
            "dose":           round(random.uniform(0.5, 2.0), 1),
            "administered_at":admin_date,
            "next_due_at":    next_due,
            "notes":          random.choice(["", "", "Реакции нет"]),
        }
        if staff_ids:
            data["staff_id"] = random.choice(staff_ids)
        r = api("POST", "/vaccinations", data)
        if r:
            vacc_count += 1
            print(f"  ✓ [{i+1:02d}] {pet_name:<12} — {vacc_name}")
    print(f"  → {vacc_count} вакцинаций\n")

    # ── Итог ──────────────────────────────────────────────────────────────
    print("=" * 60)
    print("✅ Данные загружены:")
    print(f"   Персонал:    {len(staff_ids):>3}")
    print(f"   Каталог:     {len(items_db):>3}  (касса = 60% от цены)")
    print(f"   Владельцы:   {len(owner_ids):>3}")
    print(f"   Питомцы:     {len(pet_list):>3}")
    print(f"   Приёмы:      {visit_count:>3}  (все позиции с item_id из каталога)")
    print(f"   Вакцинации:  {vacc_count:>3}")
    print("=" * 60)
    print()
    print("Для проверки отчёта:")
    print("  1. Откройте браузер → Отчёты")
    print("  2. Выберите сегодняшнюю дату или любую из последних 60 дней")
    print("  3. Нажмите 'Сформировать отчёт'")
    print("  4. В колонке 'Касса' должны быть суммы = 60% от 'Суммы'")
    print()
    print(f"  Откройте: http://localhost:8080")


if __name__ == "__main__":
    main()
