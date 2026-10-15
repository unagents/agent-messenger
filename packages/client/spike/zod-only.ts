import { z } from "zod/v4";

const s = z.object({ name: z.string() });
console.log(JSON.stringify(s.parse({ name: "zod-only" })));
