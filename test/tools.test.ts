import { describe, expect, it } from "vitest";
import { routeCost, slimPlan, summarizeTrip, toApiCharging, toApiDestination } from "../src/tools.js";

describe("routeCost", () => {
  it("sums the default cost entry of each charger stop", () => {
    const route = {
      legs: [
        {
          origin: {
            charger: {
              costs: [
                { cost: 10, currency: "EUR", isDefault: true },
                { cost: 9, currency: "EUR" },
              ],
            },
          },
        },
        { origin: { charger: { costs: [{ cost: 5.5, currency: "EUR", isDefault: true }] } } },
        { origin: {} },
      ],
    };
    expect(routeCost(route)).toEqual({ amount: 15.5, currency: "EUR" });
  });

  it("returns undefined when there are no costs", () => {
    expect(routeCost({ legs: [{ origin: {} }] })).toBeUndefined();
  });
});

describe("slimPlan", () => {
  it("strips geometry + chargeProfile, keeps scalars, and adds cost", () => {
    const plan = {
      planId: "2-x",
      routes: [
        {
          legs: [
            {
              origin: {
                name: "Stop A",
                chargeProfile: [1, 2, 3],
                charger: { costs: [{ cost: 4, currency: "EUR", isDefault: true }] },
              },
              driveDetails: {
                durationSec: 100,
                driveDistanceM: 2000,
                consumedSoc: 0.1,
                consumedW: 1,
                polyline: { value: "_p~iF" },
                geometryPointInfo: { socFrac: [1, 2] },
                instructions: [1, 2, 3],
              },
            },
          ],
        },
      ],
    };
    const slim = slimPlan(plan) as any;
    const leg = slim.routes[0].legs[0];
    expect(leg.origin.chargeProfile).toBeUndefined();
    expect(leg.origin.name).toBe("Stop A");
    expect(leg.driveDetails.polyline).toBeUndefined();
    expect(leg.driveDetails.geometryPointInfo).toBeUndefined();
    expect(leg.driveDetails.instructionCount).toBe(3);
    expect(leg.driveDetails.durationSec).toBe(100);
    expect(slim.routes[0].estimatedChargingCost).toEqual({ amount: 4, currency: "EUR" });
  });

  it("passes non-route shapes through unchanged", () => {
    expect(slimPlan({ foo: 1 })).toEqual({ foo: 1 });
  });
});

describe("summarizeTrip", () => {
  const legs = [
    {
      origin: { name: "Start", type: "DESTINATION" },
      driveDetails: { durationSec: 3600 * 5, driveDistanceM: 500000 },
    },
    {
      origin: { name: "Mid", type: "ADDED_CHARGER", totalStayDurationSec: 1800 },
      driveDetails: { durationSec: 3600 * 5, driveDistanceM: 500000 },
    },
    { origin: { name: "End", type: "DESTINATION" }, driveDetails: { durationSec: 0, driveDistanceM: 0 } },
  ];

  it("splits into days under the drive cap", () => {
    const out = summarizeTrip(
      { routes: [{ legs }], planId: "2-z" },
      { maxDriveHoursPerDay: 8, dailyDepartTime: "09:00" },
    ) as any;
    expect(out.days.length).toBe(2);
    expect(out.days[0].from).toBe("Start");
    expect(out.days[0].to).toBe("Mid");
    expect(out.days[1].to).toBe("End");
    expect(out.summary.dayCount).toBe(2);
    expect(out.viewUrl).toContain("2-z");
  });

  it("adds dates and clock times when departDate is given", () => {
    const out = summarizeTrip(
      { routes: [{ legs }] },
      { maxDriveHoursPerDay: 8, departDate: "2026-07-22", dailyDepartTime: "09:00" },
    ) as any;
    expect(out.days[0].date).toBe("Wed 22 Jul");
    expect(out.days[0].depart).toBe("09:00");
    expect(out.days[1].date).toBe("Thu 23 Jul");
  });
});

describe("toApiCharging", () => {
  it("maps friendly fields onto the API ChargingOptions shape", () => {
    const out = toApiCharging({
      connectorTypes: ["CCS"],
      preferredFeatures: ["TRAILER_FRIENDLY"],
      preferredTags: ["food"],
      networks: [{ id: 85, preference: "EXCLUSIVE" }],
    }) as any;
    expect(out.connectorTypes).toEqual(["CCS"]);
    expect(out.featurePreferences).toEqual([{ feature: "TRAILER_FRIENDLY", preference: "PREFER" }]);
    expect(out.tagPreferences).toEqual([{ tag: "food", preference: "PREFER" }]);
    expect(out.networkPreferences).toEqual([{ id: 85, preference: "EXCLUSIVE" }]);
    expect(out.preferredFeatures).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(toApiCharging(undefined)).toBeUndefined();
  });
});

describe("toApiDestination", () => {
  it("builds a COORDINATES location", () => {
    expect(toApiDestination({ lat: 1, long: 2, name: "X" })).toEqual({
      location: { type: "COORDINATES", lat: 1, long: 2 },
      name: "X",
    });
  });
  it("builds an ADDRESS location", () => {
    expect(toApiDestination({ address: "Berlin" })).toEqual({
      location: { type: "ADDRESS", value: "Berlin" },
    });
  });
  it("builds a CHARGER_ID location", () => {
    expect(toApiDestination({ chargerId: 5 })).toEqual({ location: { type: "CHARGER_ID", value: 5 } });
  });
  it("throws when no location is given", () => {
    expect(() => toApiDestination({})).toThrow();
  });
});
