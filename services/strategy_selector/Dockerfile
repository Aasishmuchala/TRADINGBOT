FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY config/ ./config/
COPY core/ ./core/
COPY services/strategy_selector/ ./services/strategy_selector/

ENV PYTHONPATH=/app
CMD ["python", "-m", "services.strategy_selector.main"]