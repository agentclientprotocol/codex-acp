import {describe, expect, it} from "vitest";
import {APPROVAL_POLICY_META, automaticChoiceCapability, supportsAutomaticChoice} from "../permissions/automatic-choice";
import {ClientCapabilities} from "../tool-calls/ClientCapabilities";

const profile = {version: 1, owner: "instance", instanceId: "507e147b-d051-4fb3-9406-5aa9d0d2d40a", automaticChoice: true};

describe("optional Instance automatic choice", () => {
    it.each([null, undefined, {}, [], "profile", {...profile, version: 2}, {...profile, owner: "caller"},
        {...profile, instanceId: "not-an-id"}, {...profile, automaticChoice: false},
        {...profile, automaticChoice: "true"}])("ignores an absent or unsupported profile: %j", value => {
        expect(supportsAutomaticChoice({[APPROVAL_POLICY_META]: value})).toBe(false);
    });

    it.each([ClientCapabilities.from, ClientCapabilities.fromV2])("negotiates independently from reusable rules", factory => {
        const enabled = factory(null, {[APPROVAL_POLICY_META]: profile});
        expect(enabled.automaticChoice).toBe(true);
        expect(automaticChoiceCapability(enabled.automaticChoice)).toEqual({[APPROVAL_POLICY_META]: {
            version: 1, owner: "instance", producer: "agentclientprotocol.codex-acp", automaticChoice: true,
        }});
        expect(factory(null).automaticChoice).toBe(false);
        expect(automaticChoiceCapability(false)).toEqual({});
    });
});
