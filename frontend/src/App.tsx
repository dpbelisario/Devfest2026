import { useEffect, useState } from "react";
import { getHealth } from "./api/client";
import "./App.css";

type Status = "loading" | "ok" | "down" | "error";

function App() {
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    getHealth()
      .then((health) => setStatus(health.ok ? "ok" : "down"))
      .catch(() => setStatus("error"));
  }, []);

  const label: Record<Status, string> = {
    loading: "Checking backend…",
    ok: "Backend is up ✅",
    down: "Backend reported a problem",
    error: "Could not reach the backend",
  };

  return (
    <main>
      <h1>DevFest 2026</h1>
      <p role="status">{label[status]}</p>
    </main>
  );
}

export default App;
