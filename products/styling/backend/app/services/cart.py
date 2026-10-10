"""加购服务（模拟加购，feedback_type=simulated_cart）。

加购/取消加购后，同步刷新该会话草稿信号：outfit_plan.note 追加"用户加购：XX"，并把
feedback_type 置为 simulated_cart（清空加购则还原）。
"""
from app.core.database import SessionLocal
from app.models.cart import CartItem


def _ids(db, session_id: str) -> list[str]:
    rows = db.query(CartItem).filter_by(session_id=session_id).order_by(CartItem.created_at.asc()).all()
    return [r.product_id for r in rows]


def get_cart_ids(session_id: str) -> list[str]:
    db = SessionLocal()
    try:
        return _ids(db, session_id)
    finally:
        db.close()


def add(session_id: str, product_id: str) -> list[str]:
    from app.services.signals import refresh_draft_cart

    db = SessionLocal()
    try:
        exists = db.query(CartItem).filter_by(session_id=session_id, product_id=product_id).first()
        if exists is None:
            db.add(CartItem(session_id=session_id, product_id=product_id))
            db.commit()
        ids = _ids(db, session_id)
    finally:
        db.close()
    refresh_draft_cart(session_id)
    return ids


def remove(session_id: str, product_id: str) -> list[str]:
    from app.services.signals import refresh_draft_cart

    db = SessionLocal()
    try:
        db.query(CartItem).filter_by(session_id=session_id, product_id=product_id).delete()
        db.commit()
        ids = _ids(db, session_id)
    finally:
        db.close()
    refresh_draft_cart(session_id)
    return ids
