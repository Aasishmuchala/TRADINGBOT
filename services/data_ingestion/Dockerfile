FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY config/ ./config/
COPY core/ ./core/
COPY services/data_ingestion/ ./services/data_ingestion/

ENV PYTHONPATH=/app
CMD ["python", "-m", "services.data_ingestion.main"]