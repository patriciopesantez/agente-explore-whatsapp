import logging
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from agent import get_reply

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="WhatsApp Agent - Edificio Explore")

MAX_MESSAGE_LENGTH = 2000


class ChatRequest(BaseModel):
    phone_number: str
    message: str


@app.middleware("http")
async def log_requests(request, call_next):
    logger.info(">>> %s %s", request.method, request.url.path)
    return await call_next(request)


@app.post("/chat")
async def chat(req: ChatRequest):
    text = req.message[:MAX_MESSAGE_LENGTH]
    logger.info("Mensaje de %s (%d chars)", req.phone_number, len(text))
    try:
        reply, send_photos, transfer_motivo = await get_reply(req.phone_number, text)
        logger.info("Respuesta enviada a %s (fotos: %s, transferencia: %s)", req.phone_number, send_photos, transfer_motivo)
        return {"reply": reply, "send_photos": send_photos, "transfer_motivo": transfer_motivo}
    except Exception:
        logger.exception("Error no capturado en /chat para %s", req.phone_number)
        return JSONResponse(
            status_code=500,
            content={"reply": "Lo sentimos, ocurrió un error inesperado. Por favor intenta de nuevo.", "send_photos": False, "transfer_motivo": None},
        )
