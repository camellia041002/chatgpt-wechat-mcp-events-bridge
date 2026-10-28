import { createRuntime } from "../src/server.mjs";

console.log(JSON.stringify(createRuntime().transport.status()));
