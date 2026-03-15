FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY config/ ./config/
COPY core/ ./core/
COPY services/dashboard_api/ ./services/dashboard_api/
COPY alerts/ ./alerts/

ENV PYTHONPATH=/app
CMD ["python", "-m", "services.dashboard_api.main"]