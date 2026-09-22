from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.routers.instruction import router as instruction_router
from backend.routers.operator import router as operator_router
from backend.routers.protocol import router as protocol_router
from backend.routers.compile import router as compile_router
from backend.routers.export import router as export_router
from backend.routers.dispatch import router as dispatch_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create tables and run idempotent seeds in one place
    # (replaces the deprecated @router.on_event("startup") hooks).
    from backend.db.database import Base, engine, SessionLocal
    from backend.db.seed import seed_sample_instructions, seed_sample_protocols
    from backend.routers.operator import seed_operator_templates

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        seed_operator_templates(db)
        seed_sample_instructions(db)
        seed_sample_protocols(db)
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
