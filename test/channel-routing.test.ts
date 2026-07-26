import { describe, it, expect } from "vitest";
import { buildChannelToInstance, MAX_MPE_VOICE_CHANNELS } from "../src/channel-routing";
import type { InstanceRoute } from "../src/channel-routing";

// Helper: 10 non-MPE instances, channels 1..10 (the default).
function defaultRoutes(): InstanceRoute[] {
    return Array.from({ length: 10 }, (_, i) => ({
        channel: i + 1,
        mpe: false,
        mpeVoiceCount: 0,
    }));
}

describe("buildChannelToInstance", () => {
    describe("non-MPE default routing", () => {
        it("maps channels 1..10 → instances 0..9", () => {
            const map = buildChannelToInstance(defaultRoutes());
            for (let id = 0; id < 10; id++) {
                expect(map.get(id + 1)).toBe(id);
            }
        });

        it("does not map channels 11..16", () => {
            const map = buildChannelToInstance(defaultRoutes());
            for (let ch = 11; ch <= 16; ch++) {
                expect(map.has(ch)).toBe(false);
            }
        });
    });

    describe("MPE instance claims lower zone", () => {
        it("instance 0 with MPE + 4 voice channels claims channels 1..5", () => {
            const routes = defaultRoutes();
            routes[0].mpe = true;
            routes[0].mpeVoiceCount = 4;
            const map = buildChannelToInstance(routes);
            // Master=1, voice channels=2,3,4,5
            expect(map.get(1)).toBe(0);
            expect(map.get(2)).toBe(0);
            expect(map.get(3)).toBe(0);
            expect(map.get(4)).toBe(0);
            expect(map.get(5)).toBe(0);
        });

        it("MPE instance shadows non-MPE instances on claimed channels", () => {
            const routes = defaultRoutes();
            routes[0].mpe = true;
            routes[0].mpeVoiceCount = 2;
            // Instance 0 claims channels 1,2,3 (master + 2 voice channels).
            // Instance 1 normally uses channel 2, but it's now claimed by MPE.
            const map = buildChannelToInstance(routes);
            expect(map.get(1)).toBe(0); // MPE master
            expect(map.get(2)).toBe(0); // MPE voice
            expect(map.get(3)).toBe(0); // MPE voice
            // Instance 1's channel 2 is shadowed — NOT remapped to instance 1.
            expect(map.has(2)).toBe(true);
            expect(map.get(2)).not.toBe(1);
        });

        it("non-MPE instances still fill unclaimed channels", () => {
            const routes = defaultRoutes();
            routes[0].mpe = true;
            routes[0].mpeVoiceCount = 2;
            const map = buildChannelToInstance(routes);
            // Channels 1..3 claimed by MPE instance 0.
            // Channels 4..10 filled by instances 3..9 (instances 1,2 shadowed).
            expect(map.get(4)).toBe(3);
            expect(map.get(10)).toBe(9);
        });
    });

    describe("MPE voice channel clamping", () => {
        it("clamps voice channels beyond channel 16", () => {
            const routes: InstanceRoute[] = [
                { channel: 14, mpe: true, mpeVoiceCount: 10 },
            ];
            const map = buildChannelToInstance(routes);
            // Master=14, voice channels=15,16 (clamped, not 17..23).
            expect(map.get(14)).toBe(0);
            expect(map.get(15)).toBe(0);
            expect(map.get(16)).toBe(0);
            expect(map.has(17)).toBe(false);
        });

        it("respects MAX_MPE_VOICE_CHANNELS (15)", () => {
            const routes: InstanceRoute[] = [
                { channel: 1, mpe: true, mpeVoiceCount: 20 },
            ];
            const map = buildChannelToInstance(routes);
            // Should claim channels 1..16 (master + 15 voice channels).
            expect(map.size).toBe(16);
            for (let ch = 1; ch <= 16; ch++) {
                expect(map.get(ch)).toBe(0);
            }
        });
    });

    describe("mixed MPE + non-MPE", () => {
        it("later MPE instance can override earlier MPE zone channels", () => {
            const routes = defaultRoutes();
            routes[0].mpe = true;
            routes[0].mpeVoiceCount = 3; // claims 1,2,3,4
            routes[1].mpe = true;
            routes[1].mpeVoiceCount = 2; // claims 2,3,4 (overlaps!)
            const map = buildChannelToInstance(routes);
            // Pass 1 processes ALL MPE instances; later ones overwrite.
            // Instance 0 claims ch 1,2,3,4. Instance 1 overwrites 2,3,4.
            expect(map.get(1)).toBe(0);  // only instance 0's master survives
            expect(map.get(2)).toBe(1);  // overwritten by instance 1
            expect(map.get(3)).toBe(1);
            expect(map.get(4)).toBe(1);
        });
    });

    describe("edge cases", () => {
        it("empty routes → empty map", () => {
            expect(buildChannelToInstance([])).toEqual(new Map());
        });

        it("MAX_MPE_VOICE_CHANNELS is 15", () => {
            expect(MAX_MPE_VOICE_CHANNELS).toBe(15);
        });
    });
});
