from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.routers.instruction import router as instruction_router
from backend.routers.operator import router as operator_router
from backend.routers.protocol import router as protocol_router
from backend.routers.compile import router as compile_router
from backend.routers.export import router as export_router
from backend.routers.dispatch import router as dispatch_router
from backend.routers.transport import router as transport_router
from backend.routers.binding import router as binding_router
from backend.routers.recipe import router as recipe_router
from backend.routers.datahub import router as datahub_router
from backend.routers.profile import router as profile_router
from backend.routers.response_spec import router as response_spec_router
from backend.routers.sequence import router as sequence_router
from backend.routers.logs import router as logs_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create tables and run idempotent seeds in one place
    # (replaces the deprecated @router.on_event("startup") hooks).
    from backend.db.database import (
        Base,
        engine,
        SessionLocal,
        ensure_binding_columns,
        ensure_protocol_version_column,
        ensure_recipe_columns,
        ensure_sequence_step_columns,
    )
    from backend.db.seed import seed_sample_instructions, seed_sample_protocols
    from backend.routers.operator import seed_operator_templates

    Base.metadata.create_all(bind=engine)
    # 批次五: create_all 不给既有表补列 → protocols 缺 version 列先自愈
    # （幂等；新库已带列则 no-op），种子/路由再进场。
    ensure_protocol_version_column(engine)
    # 批次一 1a: protocol_bindings 三列 + 部分唯一索引自愈（同上口径）。
    ensure_binding_columns(engine)
    # CP3 3a: instructions.default_recipe_id 单列自愈（同上口径）。
    ensure_recipe_columns(engine)
    # CP3 3c (D6-B): sequence_steps.wrap 单列自愈（同上口径）。
    ensure_sequence_step_columns(engine)
    db = SessionLocal()
    try:
        seed_operator_templates(db)
        seed_sample_instructions(db)
        seed_sample_protocols(db)
        # P1 连接持久化：先恢复上次生效配置（此时尚未挂钩，不回写），
        # 再挂配置变更钩子 → 之后每次 POST /transport/config 落库。
        from backend.core import transport
        from backend.db.transport_store import persist_hook, restore_transport_config

        restore_transport_config(db)
        transport.set_persist_hook(persist_hook(SessionLocal))
        # P5 日志钩子：Runner 每步独立会话写 dispatch_logs（测试在 setUp 自注、reset 清）
        from backend.core import sequence_runner
        from backend.db.log_store import log_hook

        sequence_runner.set_log_hook(log_hook(SessionLocal))
    finally:
        db.close()
    yield


app = FastAPI(title="YoRHa-HexFlow API", lifespan=lifespan)

# Setup CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production replace with specific origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {"message": "YoRHa-HexFlow Logic Engine Online", "status": "Glory to Mankind"}


app.include_router(instruction_router)
app.include_router(operator_router)
app.include_router(protocol_router)
app.include_router(compile_router)
app.include_router(export_router)
app.include_router(dispatch_router)
app.include_router(transport_router)
app.include_router(binding_router)
app.include_router(recipe_router)
app.include_router(datahub_router)
app.include_router(profile_router)
app.include_router(response_spec_router)
app.include_router(sequence_router)
app.include_router(logs_router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
