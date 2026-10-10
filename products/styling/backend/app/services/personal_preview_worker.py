"""Bounded local worker over the durable preview queue, with query-only recovery."""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import uuid

from app.services.personal_preview_media import MediaError, normalize_photo
from app.services.personal_preview_provider import (ProviderError, ProviderSubmissionUnknown, get_provider,
                                                   reference_binding)


def _store():
    from app.services.personal_preview import get_store
    return get_store()


def cleanup(store=None):
    return (store or _store()).cleanup()


def run_once(store=None, provider=None, worker_id=None):
    store = store or _store()
    provider = provider or get_provider()
    job = store.claim_next(worker_id or "PPW_" + uuid.uuid4().hex)
    if job is None:
        return False
    # provider_id is the adapter name (e.g. "mock"), not its request identity.
    # After process loss immediately following accepted submit only dispatch_id
    # may be known; query it without inventing an external provider request ID.
    provider_id = job.get("provider_request_id")
    processing_output = False
    try:
        if job.get("recover_only"):
            outcome = provider.query(job["dispatch_id"], provider_id)
        else:
            photo = store.media.read(job["input_key"])
            try:
                references = store.reference_inputs(job)
            except Exception as error:
                if getattr(error, "code", None) in {"PREVIEW_REFERENCE_UNAVAILABLE", "PREVIEW_LOOK_INELIGIBLE",
                                                    "PROFILE_OWNER_INVALID", "PREVIEW_AUTH_NOT_SUPPORTED"}:
                    raise ProviderError(error.code) from None
                raise
            reference_binding(references)
            items = job["snapshot"].get("items")
            if not isinstance(items, list) or len(items) != 3:
                raise ProviderError("PREVIEW_REFERENCE_UNAVAILABLE")
            fields = {"slot", "sku_id", "product_id", "reference_asset_id", "reference_version", "reference_sha256"}
            expected = {item.get("slot"): {key: item.get(key) for key in fields} for item in items}
            if (set(expected) != {"top", "bottom", "shoes"}
                    or any(expected.get(reference["slot"]) != {key: reference.get(key) for key in fields}
                           for reference in references)):
                raise ProviderError("PREVIEW_REFERENCE_UNAVAILABLE")
            outcome = provider.submit(job["dispatch_id"], job["snapshot"], photo, references)
        if not isinstance(outcome, dict):
            raise ProviderSubmissionUnknown(provider_id)
        if outcome.get("status") == "running":
            store.acknowledge(job, outcome)
            return True
        if outcome.get("status") == "provider_unknown":
            store.mark_unknown(job, outcome.get("provider_request_id"))
            return True
        if outcome.get("status") not in {"failed", "output_pending_review", "succeeded"}:
            raise ProviderSubmissionUnknown(outcome.get("provider_request_id", provider_id))
        if outcome.get("status") != "failed":
            if outcome.get("snapshot_digest") != job["snapshot"].get("snapshot_digest"):
                outcome = {**outcome, "status": "failed", "error_code": "PREVIEW_OUTPUT_INVALID"}
                outcome.pop("data", None)
            else:
                processing_output = True
                decoded = normalize_photo(outcome.get("data"))
                outcome = {**outcome, "data": decoded.data, "output_sha256": decoded.sha256,
                           "width": decoded.width, "height": decoded.height, "mime_type": decoded.mime_type}
                # No available adapter has verified the semantics of the three
                # garments. Mock/readability alone is never a success criterion.
                if outcome.get("is_mock") or outcome.get("semantic_verified") is not True:
                    outcome.update(status="output_pending_review", semantic_verified=False)
        store.finish(job, outcome)
    except ProviderSubmissionUnknown as error:
        store.mark_unknown(job, error.provider_request_id or provider_id)
    except ProviderError as error:
        # No real adapter is enabled. An unavailable configuration does not
        # attempt transport or borrow an old image-generation credential.
        store.finish(job, {"status": "failed", "error_code": error.code, "is_mock": getattr(provider, "is_mock", False),
                           "semantic_verified": False, "cost_status": "unknown"})
    except MediaError as error:
        store.finish(job, {"status": "failed", "error_code": "PREVIEW_OUTPUT_INVALID" if processing_output
                           else error.code, "is_mock": getattr(provider, "is_mock", False),
                           "semantic_verified": False, "cost_status": "unknown"})
    except (OSError, TimeoutError, ValueError, KeyError):
        # Ambiguous local failure may follow submit. Retain its original dispatch
        # and unknown cost; recovery must query, never turn it into another POST.
        store.mark_unknown(job, provider_id)
    return True


async def poll(store=None, *, interval=0.25):
    store = store or _store()
    provider = get_provider()
    worker_id = "PPW_" + uuid.uuid4().hex
    while True:
        # All enabled provider steps are bounded local SQLite/Pillow operations.
        # Await only after completion: cancellation leaves no worker thread or
        # in-flight daemon, and persistent attempt facts survive hard process loss.
        try:
            store.cleanup()
            if getattr(provider, 'mode', None) == 'runninghub':
                # Keep API responsive during bounded network requests. Shield and
                # drain the step on graceful shutdown; never abandon a live POST.
                step = asyncio.create_task(asyncio.to_thread(run_once, store, provider, worker_id))
                try:
                    await asyncio.shield(step)
                except asyncio.CancelledError:
                    await step
                    raise
            else:
                run_once(store, provider, worker_id)
        except Exception:
            # An uncommitted/leased operation remains durable. Its original
            # attempt can be queried on the next recovery tick; no raw exception
            # (paths, credentials or user details) is put in ordinary logs.
            logging.getLogger(__name__).warning("Personal preview local worker tick deferred")
        await asyncio.sleep(interval)


def main():
    parser = argparse.ArgumentParser(description="Isolated personal preview worker (no real provider transport)")
    parser.add_argument("--cleanup", action="store_true")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    if os.getenv("STYLING_PERSONAL_PREVIEW_ENABLED", "0") != "1":
        raise SystemExit("PREVIEW_DISABLED")
    if args.cleanup:
        cleanup()
    elif args.once:
        run_once()
    else:
        asyncio.run(poll())


if __name__ == "__main__":
    main()
