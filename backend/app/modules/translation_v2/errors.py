"""Typed V2 failures shared by execution and durable storage."""
class TrialError(RuntimeError):
    def __init__(self, code: str, **details):
        self.code, self.details = code, details
        super().__init__(code)
