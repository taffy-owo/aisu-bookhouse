# 外部翻译与发布核验

凭据先通过 `GET /api/v1/auth/api-capabilities` 核对有效期、权限和书籍范围。
读取需要 `book_read`；续章需要 `book_append`；重解析、任务对账需要
`book_manage`；替换原文件需要 `book_delete`；导入新书需要 `book_import`。
不要将密钥写进 EPUB、脚本、URL 或日志。

## 正常更新

1. `GET /books/{book_id}/continuation` 读取当前版本、章节来源和翻译约定。
2. `POST /books/{book_id}/continuation`，提供新的 `request_id`、读取到的
   `expected_revision`，以及译文 `chapters`。每章提供准确的 `source_url`。
   该操作同时写入原 EPUB/TXT 和在线目录，检测重复内容与并发修改。
3. `GET /books/{book_id}/publication-check` 核对 `in_sync: true`。
   该检查使用受大小与解压限制约束的生产解析器读取临时副本，比较实际正文
   和在线章节内容；不会修改书籍、任务或原文件。`revision` 同时覆盖原文件
   哈希、阅读索引和正文内容。不能只用章节数量或通知数量判断发布成功。

以上及下文路径统一以 `/api/v1` 为前缀。

## 由外部工具接管失败任务

1. `GET /translations/{job_id}/external` 返回原作目录、缓存可用性和
   `updated_at`，不会返回模型密钥、服务器路径或内部提示词。
2. `GET /translations/{job_id}/external/chapters/{source_index}` 导出一章已保存
   的原文和 `source_hash`。V2 快照会验证自身哈希和章节身份；没有下载的快照
   返回 409，不会偷偷联网或消耗模型调用。这里的编号是原作目录序号，
   可能与标题中的“第几话”不同。
3. 外部完成翻译后，通过上面的续章流程发布；全本使用 `/uploads/books` 或
   `/agent/projects` 导入。原有整本已更新时可使用
   `POST /uploads/books/{book_id}/replace`，并轮询 `/uploads/tasks/{task_id}`。
4. 原文件曾被 SSH 直接覆盖时，调用 `POST /uploads/books/{book_id}/reprocess`
   并等待处理完成，再做 `publication-check`；不要重复追加已有章节。
5. `POST /translations/{job_id}/reconcile` 关联并核验外部成果：

```json
{
  "request_id": "<fresh UUID; retries reuse the same UUID and body>",
  "book_id": "<published book UUID>",
  "expected_book_revision": "<publication-check.revision>",
  "expected_job_updated_at": "<current job.updated_at>",
  "acknowledge": false
}
```

该操作要求任务已停止且没有 worker 租约，双方同属当前账户、来源一致，
且原文件与在线正文完全一致。逐章返回来源 URL、来源序号或唯一标题编号的
匹配证据；编号重置和重复章不能靠数量强行通过。无法证明覆盖或发生并发
修改返回 409，保留原任务及检查点。
保存文件名中的编号不能作为来源证明；手工备注与来源章节必须依靠真实来源标记区分。

成功后任务为 `ready`、阶段为 `external_completed`，并保存此前状态、错误、
文件哈希及逐章证据。它仅证明发布内容覆盖，不声称自动文学质检通过。
使用相同请求 ID 和请求体重试得到原回执；修改请求体必须换新 ID。
需要清理通知时可以显式提供 `acknowledge: true`，或另调原有 acknowledge
接口。不要直接把失败上传改成 ready，也不要把待审任务全部改成 completed。

## 并行翻译与重复发布保护

网页后台任务与外部工具共用来源章节校验。外部提交的每章都应提供准确的
`source_url`，否则无法可靠识别两份不同译文是否来自同一原章。

- 同一本书仍在排队、翻译或等待额度时，外部续章返回 409
  `translation_in_progress`。先暂停任务，等 worker 租约释放后再接管。
  文件替换、重解析和没有来源标记的手工追加也会等待后台任务停稳。
  已停止但尚未解决的旧批次，返回 `translation_batch_pending` 时应先接管或
  对账该批次，不能越过它追加后续章节，以免目录顺序错乱。
  用户手工备注仍可在任务停稳后追加；外部译文章节请使用 `continuation` 并提供来源链接。
- 外部成果已入库时，旧任务的重试、继续和接受译稿返回 409
  `source_chapters_already_published`；请核验后调用 `reconcile`。后台领取到
  旧任务也会在请求模型前暂停，最终 EPUB 发布仍会再次检查，避免重复追加。
  已接受的 V2 译稿直接发布该份缓存，不会因模型设置或前文校订而重新翻译。
- 批次只有部分章节入库时同样停止，不会悄悄丢掉剩余章节或清除检查点。
  先处理已有成果，再为尚未覆盖的章节建立后续任务。
- 整本后台翻译与 `/agent/projects` 共用作品占用检查；已有项目返回其
  `project_id`，已有任务返回 `job_id`。原作已在书库中时返回
  `source_book_exists` 和 `book_id`，请续更或替换原书。
  暂不使用外部项目时可调用 `POST /agent/projects/{project_id}/pause` 释放作品占用，
  原文和译稿会保留；`POST /agent/projects/{project_id}/resume` 会重新检查冲突后继续。

以上冲突均保留原书、译稿和检查点。重复提交同一成功请求仍可读取原回执。

## 手工章节的安全重试

手工追加 `POST /books/{book_id}/chapters`、修改 `PUT /books/{book_id}/chapters/{index}`、
删除 `DELETE /books/{book_id}/chapters/{index}` 可使用 `Idempotency-Key: <UUID>`。
一次操作只生成一个 UUID；超时、断线或 503 后，保留原路径、正文、版本和 UUID 重试，
服务器会返回原回执，不会再次追加或删除。同一 UUID 改成另一项操作返回 409。

修改或删除前，先调用 `GET /books/{book_id}/chapters/{index}/edit`，保存返回的
`revision`，提交时带上 `If-Match: "<revision>"`。若章节已被修改或重新排序，
服务器返回 412，并且本次未执行；请保留草稿、重新打开章节核对，再决定下一步。
未确认的原操作应先使用原 UUID 和原版本核对，不要直接更换编号或版本重发删除。
为兼容旧接入，这两个请求头仍可省略；需要防止重复操作和旧窗口覆盖时必须提供。

章节修改和删除先生成完整的新文件，再与目录及回执一起切换数据库引用。
提交结果暂时无法核实时，保留相关文件，返回 503；已有可读版本不会被回滚成半成品。
确认成功后读取目录失败，只需重新读取目录，不能将它当作章节写入失败再次发起新操作。

网页编辑器会在当前标签页暂存未提交的章节名和正文，关闭弹窗、切换页面或刷新后可恢复。
不同账号、图书和章节的草稿相互隔离；只有确认写入成功或主动丢弃时才清除。
恢复的修改草稿继续使用原 `revision` 核对，不会自动换成服务器新版本来覆盖正文。
浏览器存储受限时会提示复制正文，并支持重试暂存；草稿不会自动同步到其他设备或标签页。

## 故障诊断

核验发现缺章、内容变化或文件大小不一致时返回具体 `issues`。
重新解析失败时保留旧在线目录，不会先清空书籍。任务检查点损坏时保留文件
供维护排查。systemd 日志、操作系统维护和离线备份仍使用运维工具；
业务 API 不提供任意执行代码或任意修改数据库状态的入口。
