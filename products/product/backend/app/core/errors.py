class AppError(Exception):
    """业务错误，统一转成 {"error": {"code", "message"}}。"""

    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(message)
