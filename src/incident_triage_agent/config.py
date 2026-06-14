from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os


class ConfigError(Exception):
    """Raised when runtime configuration is incomplete or invalid."""


@dataclass(frozen=True)
class AppConfig:
    minimax_api_key: str
    model_name: str
    minimax_base_url: str = "https://api.minimax.io"

    @property
    def redacted(self) -> dict[str, str]:
        return {
            "MINIMAX_API_KEY": "<redacted>",
            "MODEL_NAME": self.model_name,
            "MINIMAX_BASE_URL": self.minimax_base_url,
        }


def load_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values

    for line_number, raw_line in enumerate(path.read_text().splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ConfigError(f"Invalid .env line {line_number}; expected KEY=value.")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if not key:
            raise ConfigError(f"Invalid .env line {line_number}; missing key.")
        values[key] = value
    return values


def load_config(env_path: Path | None = None, environ: dict[str, str] | None = None) -> AppConfig:
    env_path = env_path or Path(".env")
    source = dict(environ if environ is not None else os.environ)
    source.update(load_dotenv(env_path))

    missing = [name for name in ("MINIMAX_API_KEY", "MODEL_NAME") if not source.get(name)]
    if missing:
        names = ", ".join(missing)
        raise ConfigError(f"Missing required configuration: {names}.")

    return AppConfig(
        minimax_api_key=source["MINIMAX_API_KEY"],
        model_name=source["MODEL_NAME"],
        minimax_base_url=source.get("MINIMAX_BASE_URL", "https://api.minimax.io"),
    )


def redact_secret(text: str, config: AppConfig | None = None) -> str:
    if config and config.minimax_api_key:
        return text.replace(config.minimax_api_key, "<redacted>")
    return text
