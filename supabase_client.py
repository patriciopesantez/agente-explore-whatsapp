import httpx
from datetime import date
from config import SUPABASE_URL, SUPABASE_SERVICE_KEY

_ENTREGA = date(2028, 4, 1)

def _meses_hasta_entrega() -> int:
    hoy = date.today()
    meses = (_ENTREGA.year - hoy.year) * 12 + (_ENTREGA.month - hoy.month)
    return max(meses, 1)

_HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
}
_BASE = f"{SUPABASE_URL}/rest/v1"


async def _get(path: str, params: dict = None) -> list:
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{_BASE}{path}", headers=_HEADERS, params=params)
        r.raise_for_status()
        return r.json()


async def _post(path: str, data: dict) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{_BASE}{path}",
            headers={**_HEADERS, "Prefer": "return=representation"},
            json=data,
        )
        r.raise_for_status()
        return r.json()


async def get_available_units(tipo: str = None) -> list[dict]:
    params = {"estado": "eq.Disponible", "select": "id,nombre_unidad,tipo,piso,area_interna,area_terraza,descuento_porcentaje"}
    if tipo:
        params["tipo"] = f"eq.{tipo}"
    units = await _get("/units", params)
    return units


async def get_pricing() -> dict[str, float]:
    rows = await _get("/pricing_config")
    return {r["tipo"]: r["precio_m2"] for r in rows}


def _cuota_mensual(precio_final: float, entrada_inicial: float = 5000, meses: int = 22) -> dict:
    entrada_objetivo = precio_final * 0.30
    saldo = entrada_objetivo - entrada_inicial
    if saldo <= 0 or meses <= 0:
        return {"entrada_objetivo": round(entrada_objetivo), "cuota_mensual": 0, "meses": meses}
    tasa = 0.16 / 12
    cuota = saldo * (tasa * (1 + tasa) ** meses) / ((1 + tasa) ** meses - 1)
    return {
        "entrada_objetivo": round(entrada_objetivo),
        "entrada_inicial": round(entrada_inicial),
        "saldo_en_cuotas": round(saldo),
        "cuota_mensual_aprox": round(cuota),
        "meses": meses,
        "saldo_a_entrega": round(precio_final * 0.70),
    }


async def calculate_unit_price(unit: dict, pricing: dict, meses_hasta_entrega: int = None) -> dict:
    if meses_hasta_entrega is None:
        meses_hasta_entrega = _meses_hasta_entrega()
    area_interna = unit.get("area_interna", 0)
    area_terraza = unit.get("area_terraza", 0)
    descuento = unit.get("descuento_porcentaje", 0)
    piso = unit.get("piso", 1)

    precio_m2 = 2000 + (50 * piso)  # prima por piso: $50 × número de piso
    precio_terraza_m2 = pricing.get("Terraza", 630)

    subtotal = (area_interna * precio_m2) + (area_terraza * precio_terraza_m2)
    precio_lista = subtotal
    precio_con_descuento = subtotal * (1 - descuento / 100)

    return {
        "id": unit["id"],
        "nombre_unidad": unit["nombre_unidad"],
        "tipo": unit["tipo"],
        "piso": piso,
        "area_interna_m2": area_interna,
        "area_terraza_m2": area_terraza,
        "precio_lista": round(precio_lista),
        "descuento_porcentaje": descuento,
        "precio_con_descuento": round(precio_con_descuento),
        "plan_flexible": _cuota_mensual(precio_lista, meses=meses_hasta_entrega),
    }


async def register_lead(nombre: str, telefono: str, interes: str, mensaje: str, unidad_id: str = None) -> dict:
    data = {
        "nombre": nombre,
        "telefono": telefono,
        "mensaje": mensaje,
        "unidad_interes": unidad_id,
        "detalles_financieros": {
            "interes_declarado": interes,
            "canal": "WhatsApp",
        },
    }
    result = await _post("/leads", data)
    return result[0] if isinstance(result, list) else result
