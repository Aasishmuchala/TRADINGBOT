Run `cargo run --bin sthyra-supervisor` from the repo root to refresh the local runtime snapshot.
Then run `npm install` once in this folder, followed by `npm run dev` to start the Next.js dashboard on port 4173.
The Next.js app reads ./runtime/runtime_snapshot.json on the server and falls back to built-in sample data if unavailable.


