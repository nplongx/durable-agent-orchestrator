# Agent Skills cho custom roles

Tài liệu này mô tả MVP gắn một hoặc nhiều Agent Skills vào một custom role của Local Agent Orchestrator. Role vẫn là bản ghi SQLite có version; skill là gói chỉ dẫn tùy chọn giúp role thực hiện một loại công việc theo quy trình lặp lại.

## Định dạng skill

Mỗi skill là một thư mục có file `SKILL.md` ở thư mục gốc. File này bắt đầu bằng YAML frontmatter và có phần hướng dẫn Markdown:

```markdown
---
name: documentation-style
description: Formats documentation consistently and identifies verification status.
---

# Documentation style

When writing release notes:
- Include a short summary and explicit verification status.
- Distinguish executed checks from suggested checks.
- Do not claim tests ran without execution evidence.
```

`name` phải là slug chữ thường gồm chữ cái, số và dấu gạch nối, dài tối đa 64 ký tự; `description` bắt buộc, dài tối đa 1024 ký tự. `name` phải trùng với tên thư mục skill khi nhập từ thư mục. Dạng frontmatter hỗ trợ tối thiểu trong MVP là các trường scalar `name` và `description`; nên dùng một dòng cho mỗi trường để tránh khác biệt YAML phức tạp.

Các tài nguyên tùy chọn có thể được đặt cạnh `SKILL.md`:

```text
documentation-style/
├── SKILL.md                 # bắt buộc: metadata và hướng dẫn
├── references/
│   └── style-guide.md       # tài liệu tham khảo
├── scripts/
│   └── lint-docs.sh         # chỉ được nhập dạng text, KHÔNG tự chạy
└── assets/
    └── template.md         # template dạng text
```

`references/`, `scripts/` và `assets/` không bắt buộc; không cần bổ sung file nào khác chỉ để role hoạt động. Trong MVP, các file text thuộc phần mở rộng được hỗ trợ được lưu vào snapshot và phần nội dung được đưa vào task context. File nhị phân (ví dụ ảnh PNG) bị bỏ qua. Các file tham khảo nên ngắn và chỉ chứa thông tin thật sự cần đưa vào ngữ cảnh; không dùng thư mục skill làm kho chứa bí mật hoặc dữ liệu dự án lớn.

## Gắn skill vào role

Tool `custom_role_create` nhận thêm thuộc tính tùy chọn `skills` — danh sách đường dẫn local hoặc URL GitHub công khai. Ví dụ input cho MCP:

```json
{
  "role_id": "release-documenter",
  "name": "Release Documenter",
  "description": "Writes release notes with verifiable claims.",
  "system_prompt": "Write concise release notes. Do not claim unverified work.",
  "input_contract": ["job.request", "implementation", "qa-report"],
  "output_artifact_type": "documentation",
  "allowed_capabilities": ["documentation.write"],
  "permissions": ["workspace.read", "artifact.create"],
  "allowed_tools": ["workflow_get", "workflow_artifacts"],
  "skills": [
    ".agents/skills/documentation-style",
    "https://github.com/<owner>/<repo>/tree/<branch>/<path-to-skill>"
  ]
}
```

Nguồn local có thể là đường dẫn tuyệt đối, `~/...`, hoặc đường dẫn tương đối với `CHAT_ON_STEROIDS_WORKSPACE`/workspace đang cấu hình. Local importer bắt buộc có `SKILL.md` gốc, từ chối symlink bên trong skill, bỏ qua file/thư mục ẩn và các thư mục phụ thuộc/build phổ biến.

Các dạng remote được hỗ trợ:

- `https://github.com/<owner>/<repo>/tree/<branch>/<path-to-skill>` để nhập thư mục skill.
- `https://github.com/<owner>/<repo>/blob/<branch>/<path-to-skill>/SKILL.md` để nhập thư mục chứa file đó.
- `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path-to-skill>/SKILL.md` để nhập từ đường dẫn raw.

Chỉ cho phép hostname GitHub công khai đã định danh và HTTPS; không theo redirect. MVP hiện không hỗ trợ private repository, credential, GitHub branch/ref có dấu `/`, URL tùy ý hoặc tải file thực thi để chạy. Khi cần một skill trên internet, dùng URL thư mục cụ thể; tải/import chỉ xảy ra khi người dùng gọi công cụ tạo/cập nhật role có `skills`.

## Snapshot và version

- Mỗi role có tối đa 8 skill.
- Mỗi skill có tối đa 40 file text, tối đa 32 KiB/file; tổng dữ liệu skill được nhập của một role tối đa 160 KiB.
- Nội dung được snapshot vào SQLite cùng role version và có SHA-256. Sửa/xóa folder nguồn không thay đổi snapshot đã lưu.
- `custom_role_update` không có thuộc tính `skills` sẽ giữ snapshot cũ; truyền `skills: []` để xóa skill trong version mới; truyền danh sách mới để nhập snapshot mới.
- `custom_role_clone` giữ nguyên snapshot của nguồn nếu không truyền `skills`; nếu truyền `skills`, sẽ nhập bộ skill thay thế.
- Custom workflow tiếp tục pin role version. Preview/run cũ vì thế giữ đúng bộ skill của version role mà nó đã tham chiếu.

## Cách role sử dụng skill và giới hạn an toàn

Khi `workflow_next_task` trả một custom-role task, mô tả task sẽ chứa system prompt của role, tên/description/hash của từng skill, nội dung `SKILL.md` và các file text hỗ trợ. Skill là hướng dẫn bổ sung chứ không phải cấu hình quyền hạn:

- Skill không thể thêm runtime tools hoặc quyền shell/write vào role.
- File `scripts/` chỉ là text tham khảo; plugin không thực thi chúng.
- Mọi chỉ dẫn nhập từ skill được xem là nội dung không đáng tin cậy và không được phép vượt quyền hướng dẫn của hệ thống, role, workflow, hoặc các bước phê duyệt.
- Nếu skill yêu cầu quyền hoặc tài nguyên runtime mà role không có, role phải báo giới hạn chứ không được tự mở quyền.

Vì skill và file hỗ trợ được đưa vào prompt, chúng chiếm context và có thể chứa prompt injection. Chỉ nhập nguồn đáng tin, review nội dung trước khi dùng, và tránh chứa token, mật khẩu, thông tin cá nhân hay dữ liệu riêng tư. Cơ chế này nhắm tới mức local-development chạy được; chưa phải sandbox hay quy trình supply-chain an toàn cho production.

## Gắn profile và Skills vào built-in workflow

`standard-engineering` hỗ trợ tùy chọn `role_bindings` trong `workflow_create`. Binding tham chiếu custom role đã lưu, không nhận prompt hoặc nội dung Skill tùy ý trong proposal:

```json
{
  "workflow": "standard-engineering",
  "role_bindings": [
    {
      "role": "architect",
      "custom_role_id": "architecture-specialist",
      "custom_role_version": 1
    }
  ]
}
```

- `role` là built-in specialist cần nhận guidance bổ sung; mỗi role chỉ được bind một lần.
- `custom_role_id` và `custom_role_version` phải trỏ đến version đã tồn tại. Không có lựa chọn ngầm `latest`; version không hợp lệ sẽ bị từ chối.
- Khi tạo proposal, runtime ghi `profile_hash` của snapshot. Khi approve/compile, runtime resolve lại đúng version và xác minh hash. Profile prompt, Skill instructions và supporting text được pin vào immutable execution plan, nằm trong plan hash.
- Input contract của profile phải bao phủ inputs bắt buộc của built-in role và output artifact type phải trùng khớp. Binding sai schema, version, hash hoặc contract phải fail closed.
- Overlay hiện chỉ hỗ trợ `standard-engineering`. Các role chuyên môn gồm `product-owner`, `researcher`, `architect`, `engineer`, `security`, `qa`, `platform`, `writer` và `reviewer`.
- Built-in role contract vẫn có thẩm quyền: role identity, capability, permissions, allowed tools, executor, artifact schema, dependencies, completion criteria và safety/review gates không bị profile ghi đè. `permissions` và `allowed_tools` trong profile không cấp thêm quyền runtime.
- `cto` và `system-workflow-coordinator` không thể nhận overlay. Custom workflows giữ nguyên cơ chế role-version pinning hiện có.
- Không truyền `role_bindings` giữ hành vi built-in cũ. Không tự động gán mọi Skill cho mọi role.

Dashboard hiển thị proposal pins tại **Roles & skills → Built-in role profile overlays**. Đây là binding của proposal; không nên hiểu là workflow đã được approve hoặc chạy chỉ vì hàng pin xuất hiện. Skill vẫn là nội dung không đáng tin cậy: review nguồn trước khi dùng, không chạy scripts nhập vào và không đưa secrets vào Skill.

## Tham khảo định dạng

- [Agent Skills specification](https://github.com/agentskills/agentskills) — quy ước `SKILL.md`, frontmatter và thư mục tài nguyên.
- [OpenAI: Skills](https://developers.openai.com/api/docs/guides/tools-skills/) — skill đóng gói hướng dẫn/workflow, khác với MCP server vốn cung cấp công cụ và khả năng truy cập.
- [OpenAI: Build skills](https://developers.openai.com/api/docs/guides/tools-skills/build-skills/) — khuyến nghị nêu rõ khi nào dùng, đầu vào, quy trình, đầu ra và giới hạn.
