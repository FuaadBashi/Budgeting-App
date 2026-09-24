from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://localhost/budgetapp"
    test_database_url: str = "postgresql+psycopg://localhost/budgetapp_test"
    echo_sql: bool = False

    #: Empty means authentication is off. Set it with scripts/set_password.py.
    #: The password itself is never stored -- only this hash.
    auth_password_hash: str = ""
    #: Signs session cookies. Kept separate from the password hash so the hash
    #: can only verify a password, never mint a session.
    session_secret: str = ""
    #: Send the session cookie only over HTTPS. Leave false for localhost.
    cookie_secure: bool = False
    #: Browser origins allowed to call the API, comma-separated. The default is
    #: the local dev server; a deployment must set its real origin, because
    #: cookies are only sent to origins on this list.
    cors_origins: str = "http://localhost:3000"

    @property
    def allowed_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    #: Where scheduled backups are written. Relative paths resolve against the
    #: process working directory, which for the usual `uvicorn` invocation is
    #: `backend/`.
    backup_dir: str = "backups"
    backup_enabled: bool = True
    #: How often the in-process timer writes one. The timer only runs while the
    #: API does; see docs/HANDOFF.md for wiring it to cron instead.
    backup_interval_hours: int = 24
    #: How many to retain. Zero or less keeps everything -- a misread config
    #: must not be a data-loss event.
    backup_keep: int = 14

    #: Which provider to use. "none" is the default and means every model
    #: feature is off. "openai_compatible" covers Ollama, Groq, OpenRouter,
    #: Together, LM Studio and anything else speaking that shape. "anthropic"
    #: uses the Anthropic SDK, which is an optional extra.
    llm_provider: str = "none"
    #: Chat-completions base URL, including /v1. Ignored by the anthropic
    #: provider. Local default: http://localhost:11434/v1
    llm_base_url: str = "http://localhost:11434/v1"
    #: Empty is correct for Ollama and LM Studio, which want no key.
    llm_api_key: str = ""
    #: Classification is a small-model job. Reserve larger ones for prose.
    llm_model: str = "llama3.2"
    #: Hard ceiling on a single reply. Categorisation answers are a few tokens;
    #: this is a runaway guard, not a target.
    llm_max_tokens: int = 256
    #: Reading a receipt needs a vision model, which is a different and usually
    #: larger one than classification uses.
    llm_vision_model: str = "llama3.2-vision"
    #: Only read by the anthropic provider. Kept separate so switching provider
    #: does not mean rewriting three unrelated settings.
    anthropic_api_key: str = ""

    #: Bank sync. "none" is the default and means no bank is ever contacted --
    #: like the model features, a stray credential does not switch it on.
    #: "enable_banking" uses Enable Banking's account-information API, whose
    #: free restricted mode returns only accounts you have linked yourself.
    bank_sync_provider: str = "none"
    #: The application id from the Enable Banking control panel. It is the
    #: `kid` of every signed request, not a secret.
    enable_banking_app_id: str = ""
    #: Path to the application's private key (PEM). The key is the secret; it
    #: is read from disk per request and never logged, returned or backed up.
    enable_banking_key_path: str = ""
    #: Where the bank sends the person back after they consent. Must be
    #: registered, exactly, as a redirect URL for the application.
    bank_sync_redirect_url: str = "http://localhost:3000/accounts/bank/callback"
    bank_sync_country: str = "GB"


settings = Settings()
