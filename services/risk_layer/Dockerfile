FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY config/ ./config/
COPY core/ ./core/
COPY services/risk_layer/ ./services/risk_layer/

ENV PYTHONPATH=/app
CMD ["python", "-m", "services.risk_layer.main"]