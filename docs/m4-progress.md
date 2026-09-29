# M4 Progress Snapshot

> Cập nhật: 2026-09-29
> Trạng thái: đang hoàn thiện và xác minh E2E native; chưa có kết luận pass cuối cùng cho run mới nhất.

## 1. Kiến trúc và phạm vi đã chốt

- M4 workflow sản xuất dùng DAG: **Architect → Engineer → QA → Reviewer → CTO**.
- Luồng production hiện tại vẫn lấy **Architect + QA** làm các bước chính đã được kiểm chứng; DAG M4 mở rộng thêm Engineer, Reviewer và CTO.
- Nguồn sự thật durable: **SQLite**.
- Quyền điều phối workflow: **LangGraph**.
- **OpenClaw chỉ là executor**, không phải workflow controller.
- **ExecutionManager** là authority duy nhất cho command/evidence thực thi.
- **ProviderAdmission** chỉ gate provider/resource.
- **RecoveryManager** chỉ xử lý recovery hạ tầng.
- E2E harness chỉ quan sát và verify, không điều khiển workflow.
- Không dùng agents_wait, không sửa DB thủ công, không fake evidence, không parse prose LLM để điều khiển workflow, không thêm controller thứ hai.
- Giữ các invariant: hasEvent, foreign-session guard, resume_after, và failed/stalled không được coi là success.

### Roles hiện có

ProductOwner, Researcher, Architect, Engineer, QA, Security, Platform, Reviewer, Writer, CTO.

Không dùng Coordinator/Planner và không còn Debugger trong role set.

## 2. Verification / acceptance gates

Verifier deterministic kiểm tra:

1. proposal tồn tại và plan hash hợp lệ;
2. đủ required tasks và dependency graph;
3. execution evidence + exit codes;
4. review artifact;
5. synthesis;
6. durable executive report;
7. Slack pending = 0.

Sau khi Slack pending về 0 thì verifier được chạy lại để xác nhận terminal state cuối.

## 3. Tài liệu và code đã hoàn thành

- docs/agent-architecture-proposal.md đã được tạo và hoàn thiện.
- M4 implementation đã được tích hợp vào workflow/orchestrator, runtime guards và E2E harness.
- Các thay đổi M4 hiện **chưa commit**.
- Baseline HEAD trước M4: d7b279b.

## 4. Test đã pass

- test-workflow-m4
- test-langgraph-orchestrator
- test-workflow-plan-m2
- test-workflow-policy-m1
- test-production-guards
- test-execution-manager
- Node syntax checks
- git diff --check

## 5. Production evidence đã có

Job tốt đã quan sát:

- job_5d6f8d67... hoàn tất thành công.
- Slack pending = 0.
- 51/51 checks/tasks theo snapshot lúc đó.
- Architect và QA exit code = 0.
- Đúng 2 child tasks.
- CTO hoàn tất sau một timeout được recovery.

Một số job production khác cũng đã được dùng để kiểm tra lifecycle/recovery.

## 6. Các vấn đề đã phát hiện và đã xử lý

### Legacy malformed job

- job_537... từng làm reconciliation cũ crash.
- Đã đưa job malformed về terminal failed và loại khỏi đường success/reconciliation.

### Gateway outage

- Đã xác định và xử lý outage ở gateway.

### State-lifecycle ownership collision

- Đã phát hiện tranh chấp ownership trong state lifecycle và điều chỉnh flow.

### Observation timeout của E2E

- scripts/run-m4-e2e.js được sửa để waitForNativeTurnIdle dùng sessions.list với limit 50 và retry.

### Native account rate limit / prewarm

- Một E2E run (job_7b6036a4-ac43-45d0-879c-b666c15b3ea7) bị reviewer native fail do Account 1 chạm hard rate limit.
- Runtime được bổ sung PREWARM_ALL_ACCOUNTS=true.
- Prewarm nhiều account hiện chạy concurrent bằng Promise.all; default behavior vẫn giữ nguyên nếu không bật env.
- Mục tiêu là để admission có thể sử dụng account khỏe hơn thay vì phụ thuộc Account 1.

### CTO synthesis dispatch race

- Run job_38f50357-58ae-4e08-9544-19c156e82fb9 đã đi qua proposal/approval, Architect, Engineer, QA, Reviewer với real evidence nhưng CTO synthesis fail.
- Root cause: provider model requests quay lại evaluateRequestLangGraph khi durable job đã ở EXECUTING, gây synthesis dispatch race.
- Đã patch server.js: khi durable job state là EXECUTING, evaluation trả null để provider/model turns không re-enter control plane.

### Global Slack projection

- Global Slack projection loop được đặt sau env flag SLACK_PROJECTION_GLOBAL=false để tránh backlog toàn cục tiêu thụ runtime trong E2E.
- Terminalization vẫn project trực tiếp job hiện tại.

## 7. Runtime hiện tại

Adapter được launch với:

WORKFLOW_WORKSPACE=/home/long/work/chatgpt-adapter SLACK_PROJECTION_GLOBAL=false PREWARM_ALL_ACCOUNTS=true node server.js

Runtime session được ghi nhận: 97914.

Prewarm đã chạy cho Account 1–4; các CDP ports 9021–9024 đã online. Account 1 từng có rate-limit nhưng admission có thể chuyển sang account khỏe hơn.

## 8. Native E2E mới nhất

E2E session: 46625.

Latest job:

job_cd32feaf-9236-4742-8ebf-8ce8efe1819d

Điểm cuối cùng đã quan sát:

[M4-E2E:native-specialists] {"state":"EXECUTING","phase":"ASSIGN_CHILDREN","tasks":[["cto","running",null,null],["architect","running",null,null]]}

Trước đó đã xác nhận:

- proposal durable: PASS;
- approval native: chuyển từ PROPOSED → EXECUTING;
- phase SPAWN_CTO: CTO running;
- phase ASSIGN_CHILDREN: Architect được spawn và chạy native.

Sau snapshot trên, E2E session 46625 đã được chờ thêm nhưng chưa quan sát được terminal outcome trước thời điểm ghi snapshot này.

**Vì vậy: chưa đánh dấu M4 native E2E là PASS cuối cùng.**

## 9. Việc cần làm tiếp theo

1. Kiểm tra lại session 46625 và job job_cd32feaf-9236-4742-8ebf-8ce8efe1819d để lấy terminal outcome.
2. Nếu fail, lấy evidence/phase cuối và sửa đúng boundary gây lỗi; không sửa harness để che lỗi workflow.
3. Nếu terminal success, chạy verifier deterministic sau khi Slack pending = 0.
4. Xác nhận không còn regression ở production workflow.
5. Chạy lại test suite + E2E cuối.
6. Review diff, cập nhật architecture proposal nếu implementation có thay đổi contract.
7. Commit M4 sau khi acceptance gate hoàn tất.

## 10. Nguyên tắc khi tiếp tục

- Ưu tiên durable state/evidence thay vì log hoặc prose.
- Không can thiệp DB thủ công để làm job trông như thành công.
- Không coi timeout/transient recovery là success nếu chưa có evidence terminal hợp lệ.
- Không để provider/model turn quay lại control plane sau khi job đã EXECUTING.
- Giữ production defaults an toàn; các env E2E chỉ phục vụ quan sát/prewarm/giảm nhiễu runtime.
