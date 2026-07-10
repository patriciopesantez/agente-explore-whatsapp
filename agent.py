import asyncio
import json
from collections import defaultdict
from typing import List
import anthropic
from config import ANTHROPIC_API_KEY, SYSTEM_PROMPT
from supabase_client import get_available_units, get_pricing, calculate_unit_price, register_lead

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

_history: dict[str, List[dict]] = defaultdict(list)
_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
MAX_HISTORY_TURNS = 10
MAX_TOOL_ITERATIONS = 5

TOOLS = [
    {
        "name": "transferir_a_asesor",
        "description": (
            "Notifica a un asesor humano para que haga seguimiento al cliente. "
            "Úsala cuando: (1) el lead está calificado y quiere agendar una cita o reunión presencial, "
            "(2) el cliente tiene preguntas técnicas, legales o contractuales que no puedes resolver, "
            "(3) el cliente pide hablar con una persona. "
            "Al usarla, indica al cliente que un asesor lo contactará pronto y ofrécete a seguir respondiendo dudas."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "motivo": {
                    "type": "string",
                    "description": "Breve descripción del motivo de la transferencia (ej: 'agendar visita', 'consulta legal').",
                }
            },
            "required": ["motivo"],
        },
    },
    {
        "name": "enviar_fotos",
        "description": (
            "Envía al cliente un pack de fotografías del Edificio Explore San Sebastián "
            "(renders, áreas comunes, vistas, fachada). "
            "Úsala cuando el cliente pida fotos, imágenes, renders, o quiera ver cómo es el edificio."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "buscar_unidades_disponibles",
        "description": (
            "Consulta en tiempo real las unidades disponibles para la venta en el Edificio Explore San Sebastián. "
            "Devuelve lista con nombre, tipo, piso, área y precio calculado. "
            "Úsala cuando el cliente pregunte qué unidades hay disponibles, precios, o características."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "tipo": {
                    "type": "string",
                    "enum": ["Studio", "Suite", "Departamento"],
                    "description": "Filtrar por tipo de unidad. Omitir para ver todos los tipos.",
                },
                "entrada_inicial": {
                    "type": "number",
                    "description": "Monto que el cliente pagará como entrada inicial. Por defecto $5,000. Usar cuando el cliente indique un monto diferente.",
                },
            },
            "required": [],
        },
    },
    {
        "name": "registrar_lead",
        "description": (
            "Registra en la base de datos a un cliente calificado que está listo para seguimiento comercial. "
            "Úsala SOLO cuando el cliente haya proporcionado su nombre y número de WhatsApp voluntariamente. "
            "Si el cliente mostró interés en una unidad específica vista en buscar_unidades_disponibles, pasa su id en unidad_id."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "nombre": {"type": "string", "description": "Nombre del cliente"},
                "telefono": {"type": "string", "description": "Número de WhatsApp o teléfono del cliente"},
                "interes": {"type": "string", "description": "Tipo de unidad o unidad específica de interés mencionada"},
                "mensaje": {"type": "string", "description": "Resumen breve del interés y contexto de la conversación"},
                "unidad_id": {"type": "string", "description": "UUID de la unidad específica de interés, obtenido del campo 'id' en buscar_unidades_disponibles. Omitir si no se identificó una unidad concreta."},
            },
            "required": ["nombre", "telefono", "interes", "mensaje"],
        },
    },
]


async def _execute_tool(name: str, inputs: dict) -> str:
    if name == "buscar_unidades_disponibles":
        tipo = inputs.get("tipo")
        entrada_inicial = inputs.get("entrada_inicial", 5000)
        units = await get_available_units(tipo)
        if not units:
            return json.dumps({"resultado": "No hay unidades disponibles con ese criterio en este momento."})
        pricing = await get_pricing()
        result = []
        for u in units:
            precio = await calculate_unit_price(u, pricing, entrada_inicial=entrada_inicial)
            result.append(precio)
        return json.dumps(result, ensure_ascii=False)

    if name == "registrar_lead":
        lead = await register_lead(
            nombre=inputs["nombre"],
            telefono=inputs["telefono"],
            interes=inputs["interes"],
            mensaje=inputs["mensaje"],
            unidad_id=inputs.get("unidad_id"),
        )
        return json.dumps({"resultado": "Lead registrado exitosamente.", "id": str(lead.get("id", ""))}, ensure_ascii=False)

    return json.dumps({"error": f"Herramienta desconocida: {name}"})


async def get_reply(sender_id: str, user_text: str) -> tuple[str, bool, str | None]:
    async with _locks[sender_id]:
        history = _history[sender_id]
        history.append({"role": "user", "content": user_text})

        send_photos = [False]
        transfer_motivo = [None]

        async def execute_tool(name: str, inputs: dict) -> str:
            if name == "transferir_a_asesor":
                transfer_motivo[0] = inputs.get("motivo", "sin especificar")
                return json.dumps({"resultado": "Asesor notificado. Conversación transferida."})
            if name == "enviar_fotos":
                send_photos[0] = True
                return json.dumps({"resultado": "Fotografías enviadas al cliente."})
            return await _execute_tool(name, inputs)

        iterations = 0
        while iterations < MAX_TOOL_ITERATIONS:
            response = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=1024,
                system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
                tools=TOOLS,
                messages=history,
            )

            if response.stop_reason == "tool_use":
                iterations += 1
                history.append({"role": "assistant", "content": response.content})
                tool_results = []
                for block in response.content:
                    if block.type == "tool_use":
                        result = await execute_tool(block.name, block.input)
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": result,
                        })
                history.append({"role": "user", "content": tool_results})
                continue

            reply = next(b.text for b in response.content if hasattr(b, "text"))
            history.append({"role": "assistant", "content": reply})
            break
        else:
            reply = "En este momento no puedo procesar tu consulta. Por favor escríbenos directamente a través de www.edificioexplore.com"
            history.append({"role": "assistant", "content": reply})

        if len(history) > MAX_HISTORY_TURNS * 2:
            _history[sender_id] = history[-(MAX_HISTORY_TURNS * 2):]

        return reply, send_photos[0], transfer_motivo[0]
