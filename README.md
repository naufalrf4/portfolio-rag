# RAG service

Standalone Bun/Hono retrieval service. Build with `bun install --frozen-lockfile && bun run build`. It uses private PostgreSQL access for RAG data and calls Admin internal APIs (`ADMIN_API_URL`) with service credentials. Admin owns schema migrations; `db-bootstrap` only prepares the vector extension/schema.
