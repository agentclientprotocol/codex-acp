#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import {Readable, Writable} from "node:stream";
import { ExampleAgent } from "./exampleAgent.js";

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

const stream = acp.ndJsonStream(input, output);
new acp.AgentSideConnection((conn) => new ExampleAgent(conn), stream);
