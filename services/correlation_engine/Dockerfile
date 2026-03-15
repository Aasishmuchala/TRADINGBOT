FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY config/ ./config/
COPY core/ ./core/
COPY services/correlation_engine/ ./services/correlation_engine/

ENV PYTHONPATH=/app
CMD ["python", "-m", "services.correlation_engine.main"]