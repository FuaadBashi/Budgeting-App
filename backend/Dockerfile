FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir .
COPY alembic.ini ./
COPY alembic ./alembic
COPY scripts ./scripts
EXPOSE 8000
# Migrate, then reseed: the demo is meant to be thrown away, and seed_demo dates
# everything from today, so a fresh seed on each start never shows a stale month.
CMD ["sh", "-c", "alembic upgrade head && python scripts/seed_demo.py && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
