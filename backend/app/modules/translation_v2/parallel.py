"""Parallel block work, with full read-only context and ordered stage barriers."""
import asyncio
import math

from .pilot import Analysis, Draft, Patches, Review, TrialError, digest
from .runtime import StageClient


class ParallelStageClient(StageClient):
    async def call(self, stage, payload, schema):
        source = payload.get('source_blocks', [])
        # Preserve old, fully received whole-stage checkpoints. Semantic
        # validation remains in run_trial; invalid patches get new feedback keys.
        cached = self.has_checkpoint(stage, {**payload, 'workflow_version': 'v2.1'}, schema)
        count = min(self.capacity, max(1, len(source) // 8))
        if schema not in (Analysis, Draft, Patches, Review) or count < 2 or cached:
            return await super().call(stage, payload, schema)
        width = math.ceil(len(source) / count)
        groups = [source[i:i+width] for i in range(0, len(source), width)]
        clients = []

        async def one(group):
            ids = [b['block_id'] for b in group]
            id_set = set(ids)
            scoped = {**payload, 'source_blocks': group,
                'read_only_source_context': payload.get('read_only_source_context', source),
                'parallel_scope': {'required_ids': ids,
                    'instruction': '完整上下文仅供参考。只输出或修改本次 source_blocks 的编号；不得修改其他分片。沿用共享 glossary、人物口吻和上文。'}}
            for key in ('analysis', 'candidate'):
                if key in payload:
                    scoped['read_only_' + key + '_context'] = payload.get('read_only_' + key + '_context', payload[key])
                    scoped[key] = {'blocks': [b for b in payload[key]['blocks'] if b['block_id'] in id_set]}
            if 'blocks' in payload:
                scoped['read_only_candidate_context'] = payload.get('read_only_candidate_context', {'blocks': payload['blocks']})
                scoped['blocks'] = [b for b in payload['blocks'] if b['block_id'] in id_set]
            if 'affected_block_ids' in payload:
                scoped['affected_block_ids'] = [i for i in payload['affected_block_ids'] if i in id_set]
                scoped['issues'] = [f for f in payload.get('issues', []) if f.get('block_id') in id_set]
            child = StageClient(self.endpoint, self.api_key, self.model,
                self.root / 'parallel' / stage / digest(ids), guard=self.guard, report=self.report,
                lane_root=self.lane_root, capacity=self.capacity,
                repair_retry_attempt=self.repair_retry_attempt,
                budget_path=self.budget_path, budget_scope=self.budget_scope,
                request_limit=self.request_limit, platform_settings=self.platform_settings)
            clients.append(child)
            output = await child.call(stage, scoped, schema)
            # Never let a shard touch another shard, even if the global set
            # would appear correct after merging.
            returned = ([b.block_id for b in output.blocks] if schema in (Analysis, Draft)
                        else output.checked_block_ids if schema is Review
                        else [p.block_id for p in output.patches])
            if len(set(returned)) != len(returned) or not set(returned) <= id_set:
                raise TrialError('block_coverage_mismatch', stage=stage, expected=len(ids), received=len(returned))
            return output

        tasks = [asyncio.create_task(one(group)) for group in groups]
        try:
            # Wait for every in-flight sibling to persist its receipt even when
            # one fails. No orphan writes after the job is marked failed.
            results = await asyncio.gather(*tasks, return_exceptions=True)
        except BaseException:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        finally:
            for child in clients:
                self.events.extend(child.events)
        errors = [r for r in results if isinstance(r, BaseException)]
        if errors:
            raise errors[0]
        if schema in (Analysis, Draft):
            return schema(blocks=[b for r in results for b in r.blocks])
        if schema is Review:
            return Review(checked_block_ids=[i for r in results for i in r.checked_block_ids],
                          findings=[f for r in results for f in r.findings])
        return Patches(patches=[p for r in results for p in r.patches])
