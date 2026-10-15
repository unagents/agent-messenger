import Ajv from "ajv";

console.log("imported");
const ajv = new Ajv();
console.log("constructed");
const v = ajv.compile({ type: "object", properties: { name: { type: "string" } }, required: ["name"] });
console.log("compiled");
console.log(JSON.stringify({ ok: v({ name: "ajv-only" }) }));
