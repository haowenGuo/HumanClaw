import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.schemas import (
    ChatRequest,
    ChatTextResponse,
    ChatTTSResponse,
    SpeechSynthesisRequest,
    SpeechSynthesisResponse,
    TTSAlignment,
)
from backend.core.database import get_db
from backend.services.conversation_service import ConversationService
from backend.services.llm_service import LLMService
from backend.services.reply_markup_service import parse_reply_markup
from backend.services.tts_service import ElevenLabsTTSService, ElevenLabsTTSServiceError


router = APIRouter()
MARKDOWN_BLOCK_PATTERN = re.compile(r"```.*?```", re.S)
INLINE_CODE_PATTERN = re.compile(r"`([^`]*)`")
URL_PATTERN = re.compile(r"https?://\S+")
HEADING_PATTERN = re.compile(r"^\s{0,3}#{1,6}\s*", re.M)
LIST_PREFIX_PATTERN = re.compile(r"^\s*[-*+]\s*", re.M)
TABLE_SEPARATOR_PATTERN = re.compile(r"\|")


def _to_pydantic_alignment(alignment) -> TTSAlignment | None:
    if alignment is None:
        return None

    return TTSAlignment(
        characters=alignment.characters,
        character_start_times_seconds=alignment.character_start_times_seconds,
        character_end_times_seconds=alignment.character_end_times_seconds
    )


def _estimate_duration_seconds(alignment) -> float | None:
    if alignment is None or not alignment.character_end_times_seconds:
        return None
    return max(alignment.character_end_times_seconds)


def _normalize_speech_text(text: str) -> str:
    normalized = (text or "").strip()
    normalized = MARKDOWN_BLOCK_PATTERN.sub(" ", normalized)
    normalized = INLINE_CODE_PATTERN.sub(r"\1", normalized)
    normalized = URL_PATTERN.sub(" ", normalized)
    normalized = HEADING_PATTERN.sub("", normalized)
    normalized = LIST_PREFIX_PATTERN.sub("", normalized)
    normalized = TABLE_SEPARATOR_PATTERN.sub(" ", normalized)
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.strip()


def _trim_to_sentence_boundary(text: str, max_chars: int) -> str:
    normalized = _normalize_speech_text(text)
    if len(normalized) <= max_chars:
        return normalized

    trimmed = normalized[:max_chars].rstrip("，,、；;：:")
    last_boundary = max(
        trimmed.rfind("。"),
        trimmed.rfind("！"),
        trimmed.rfind("？"),
        trimmed.rfind("."),
        trimmed.rfind("!"),
        trimmed.rfind("?"),
    )
    if last_boundary >= max(12, max_chars // 2):
        return trimmed[: last_boundary + 1].strip()
    return f"{trimmed}。".strip()


def _fallback_summary(text: str, max_chars: int) -> str:
    normalized = _normalize_speech_text(text)
    if not normalized:
        return ""

    sentences = [part.strip() for part in re.split(r"(?<=[。！？!?])\s*", normalized) if part.strip()]
    if not sentences:
        return _trim_to_sentence_boundary(normalized, max_chars)

    buffer = []
    total_length = 0
    for sentence in sentences:
        addition = sentence if sentence.endswith(("。", "！", "？", ".", "!", "?")) else f"{sentence}。"
        next_length = total_length + len(addition)
        if buffer and next_length > max_chars:
            break
        buffer.append(addition)
        total_length = next_length
        if total_length >= max_chars:
            break

    return _trim_to_sentence_boundary("".join(buffer) or normalized, max_chars)


async def _summarize_for_speech(text: str, max_chars: int) -> str:
    normalized = _normalize_speech_text(text)
    if not normalized:
        return ""

    llm_service = LLMService()
    system_prompt = (
        "你是桌面助手的语音播报摘要器。"
        "请把输入内容压缩成一段适合直接朗读的中文摘要。"
        "只保留最重要的执行结果、完成状态、关键结论和必要的下一步。"
        "如果任务失败，要直接说失败原因。"
        "不要输出 Markdown、代码块、列表、网址、路径、表格、引号包裹的前后缀。"
        f"输出控制在 {max_chars} 个中文字符以内，只输出摘要正文。"
    )

    try:
        summary = await llm_service.generate_non_stream(
            prompt=f"请为下面这段内容生成语音摘要：\n\n{normalized}",
            system_prompt=system_prompt,
            temperature=0.2,
            max_tokens=220,
        )
    except Exception:
        summary = ""

    summary = _normalize_speech_text(summary)
    if not summary:
        summary = _fallback_summary(normalized, max_chars)

    return _trim_to_sentence_boundary(summary, max_chars)


@router.post("/chat/tts", response_model=ChatTTSResponse)
async def chat_tts_endpoint(
    request: ChatRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    一次性完成：
    1. 生成最终回复文本
    2. 解析动作 / 表情控制标签
    3. 调 ElevenLabs 生成音频与时间戳

    这个接口专门服务“完整文本 + 完整音频”场景，避免影响原有流式 /chat。
    """
    try:
        conversation_service = ConversationService(db)
        turn = await conversation_service.generate_complete_reply(request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    parsed_reply = parse_reply_markup(turn.assistant_reply)
    if not parsed_reply.speech_text:
        raise HTTPException(status_code=502, detail="AI 回复为空，无法生成语音")

    try:
        tts_service = ElevenLabsTTSService()
        tts_result = await tts_service.synthesize(parsed_reply.speech_text)
    except ElevenLabsTTSServiceError as exc:
        print(f"[TTS Error] ElevenLabs 语音生成失败: {exc}")
        raise HTTPException(status_code=502, detail=f"ElevenLabs 语音生成失败：{exc}") from exc

    return ChatTTSResponse(
        session_id=turn.session_id,
        raw_text=parsed_reply.raw_text,
        display_text=parsed_reply.display_text,
        speech_text=parsed_reply.speech_text,
        audio_base64=tts_result.audio_base64,
        audio_format=tts_result.audio_format,
        mime_type=tts_result.mime_type,
        action=parsed_reply.action,
        expression=parsed_reply.expression,
        alignment=_to_pydantic_alignment(tts_result.alignment),
        normalized_alignment=_to_pydantic_alignment(tts_result.normalized_alignment),
        duration_hint_seconds=_estimate_duration_seconds(
            tts_result.normalized_alignment or tts_result.alignment
        ),
    )


@router.post("/chat/text", response_model=ChatTextResponse)
async def chat_text_endpoint(
    request: ChatRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    TTS 不可用时的降级接口：
    仍然生成完整文本，并保留动作/表情控制标签解析结果。
    """
    try:
        conversation_service = ConversationService(db)
        turn = await conversation_service.generate_complete_reply(request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    parsed_reply = parse_reply_markup(turn.assistant_reply)
    return ChatTextResponse(
        session_id=turn.session_id,
        raw_text=parsed_reply.raw_text,
        display_text=parsed_reply.display_text,
        speech_text=parsed_reply.speech_text,
        action=parsed_reply.action,
        expression=parsed_reply.expression,
    )


@router.post("/chat/speech", response_model=SpeechSynthesisResponse)
async def chat_speech_endpoint(request: SpeechSynthesisRequest):
    source_text = _normalize_speech_text(request.text)
    if not source_text:
        raise HTTPException(status_code=400, detail="待播报文本不能为空")

    if request.mode == "plain":
        speech_text = source_text
    else:
        speech_text = await _summarize_for_speech(source_text, request.max_chars)

    if not speech_text:
        raise HTTPException(status_code=502, detail="摘要结果为空，无法生成语音")

    try:
        tts_service = ElevenLabsTTSService()
        tts_result = await tts_service.synthesize(speech_text)
    except ElevenLabsTTSServiceError as exc:
        print(f"[Speech TTS Error] ElevenLabs 语音生成失败: {exc}")
        raise HTTPException(status_code=502, detail=f"ElevenLabs 语音生成失败：{exc}") from exc

    return SpeechSynthesisResponse(
        source_text=source_text,
        summary_text=speech_text,
        mode=request.mode,
        audio_base64=tts_result.audio_base64,
        audio_format=tts_result.audio_format,
        mime_type=tts_result.mime_type,
        alignment=_to_pydantic_alignment(tts_result.alignment),
        normalized_alignment=_to_pydantic_alignment(tts_result.normalized_alignment),
        duration_hint_seconds=_estimate_duration_seconds(
            tts_result.normalized_alignment or tts_result.alignment
        ),
    )
