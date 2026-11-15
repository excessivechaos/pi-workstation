import assert from "node:assert/strict";
import { test } from "node:test";
import { PACKAGES, OPTIONAL_PACKAGES, REMOVED_PACKAGES } from "../lib/workstation.mjs";
import { describePlan, planPackages, shortName } from "../lib/packages.mjs";

let checks = 0;
const ok = (v, m) => { checks++; return assert.ok(v, m); };
const eq = (a, b, m) => { checks++; return assert.deepStrictEqual(a, b, m); };

const ORG = "git:github.com/excessivechaos/";

test("a converged machine has nothing to do", () => {
	const plan = planPackages([...PACKAGES, ...OPTIONAL_PACKAGES]);
	eq(plan.install, [], "nothing missing");
	eq(plan.remove, [], "nothing to drop");
});

test("a fresh machine installs the whole list", () => {
	const plan = planPackages([]);
	eq(plan.install, PACKAGES, "every package, in order");
	eq(plan.remove, [], "nothing to remove");
});

test("a missing package is installed, others are left alone", () => {
	const plan = planPackages(PACKAGES.filter((s) => !s.includes("pi-quota-resume")));
	eq(plan.install, [PACKAGES.find((s) => s.includes("pi-quota-resume"))], "only the missing one");
});

test("retired packages are removed by name and by org", () => {
	const plan = planPackages([...PACKAGES, REMOVED_PACKAGES[0], `${ORG}pi-retired-thing`]);
	ok(plan.remove.includes(REMOVED_PACKAGES[0]), "the named retirement goes");
	ok(plan.remove.includes(`${ORG}pi-retired-thing`), "an unlisted package under our org goes");
	eq(plan.install, [], "nothing missing");
});

test("optional packages are never removed and never installed", () => {
	const plan = planPackages([...PACKAGES, ...OPTIONAL_PACKAGES]);
	eq(plan.remove, [], "optional stays when present");
	const absent = planPackages(PACKAGES);
	ok(!absent.install.some((s) => OPTIONAL_PACKAGES.includes(s)), "optional is not force-installed");
});

test("foreign sources are never touched", () => {
	const plan = planPackages([...PACKAGES, "npm:someone-elses-package", "git:github.com/other/repo"]);
	eq(plan.remove, [], "no foreign removals");
	eq(plan.install, [], "no foreign installs");
});

test("the notify line names short names", () => {
	eq(shortName(`${ORG}pi-quota-peek`), "pi-quota-peek", "git source");
	eq(shortName("npm:pi-web-access"), "pi-web-access", "npm source");
	ok(describePlan({ install: [`${ORG}pi-quota-peek`], remove: [] }).startsWith("install pi-quota-peek"), "install line");
	ok(describePlan({ install: [], remove: [`${ORG}old`] }) === "remove old", "remove line");
	eq(describePlan({ install: [], remove: [] }), "", "converged renders empty");
});

test("summary", () => console.log(`ok ${checks} checks`));
