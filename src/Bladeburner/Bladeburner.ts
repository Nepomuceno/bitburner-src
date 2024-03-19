import type { PromisePair } from "../Types/Promises";
import type { PositiveInteger } from "../types";
import type { ActionIdentifier } from "./Actions/ActionIdentifier";
import type { BlackOperation } from "./Actions/BlackOperation";
import type { Contract } from "./Actions/Contract";
import type { Operation } from "./Actions/Operation";
import type { GeneralAction } from "./Actions/GeneralAction";
import type { Action } from "./Actions/Action";
import type { Person } from "../PersonObjects/Person";
import type { NetscriptContext } from "../Netscript/APIWrapper";

import {
  AugmentationName,
  BladeActionType,
  BladeBlackOpName,
  BladeContractName,
  BladeGeneralActionName,
  BladeOperationName,
  BladeSkillName,
  CityName,
  FactionName,
} from "@enums";
import { constructorsForReviver, Generic_toJSON, Generic_fromJSON, IReviverValue } from "../utils/JSONReviver";
import { BlackOperations, blackOpsArray } from "./data/BlackOperations";
import { GeneralActions } from "./data/GeneralActions";
import { formatNumberNoSuffix } from "../ui/formatNumber";
import { Skills } from "./data/Skills";
import { City } from "./City";
import { Player } from "@player";
import { Router } from "../ui/GameRoot";
import { ConsoleHelpText } from "./data/Help";
import { exceptionAlert } from "../utils/helpers/exceptionAlert";
import { getRandomInt } from "../utils/helpers/getRandomInt";
import { BladeburnerConstants } from "./data/Constants";
import { formatExp, formatMoney, formatPercent, formatBigNumber, formatStamina } from "../ui/formatNumber";
import { currentNodeMults } from "../BitNode/BitNodeMultipliers";
import { addOffset } from "../utils/helpers/addOffset";
import { Factions } from "../Faction/Factions";
import { calculateHospitalizationCost } from "../Hospital/Hospital";
import { dialogBoxCreate } from "../ui/React/DialogBox";
import { Settings } from "../Settings/Settings";
import { getTimestamp } from "../utils/helpers/getTimestamp";
import { joinFaction } from "../Faction/FactionHelpers";
import { WorkerScript } from "../Netscript/WorkerScript";
import { KEY } from "../utils/helpers/keyCodes";
import { isSleeveInfiltrateWork } from "../PersonObjects/Sleeve/Work/SleeveInfiltrateWork";
import { isSleeveSupportWork } from "../PersonObjects/Sleeve/Work/SleeveSupportWork";
import { WorkStats, newWorkStats } from "../Work/WorkStats";
import { getEnumHelper } from "../utils/EnumHelper";
import { PartialRecord, createEnumKeyedRecord } from "../Types/Record";
import { Contracts, initContracts } from "./data/Contracts";
import { Operations, initOperations } from "./data/Operations";
import { clampInteger } from "../utils/helpers/clampNumber";
import { helpers } from "../Netscript/NetscriptHelpers";

export interface BlackOpsAttempt {
  error?: string;
  isAvailable?: boolean;
  action?: BlackOperation;
}
export const BladeburnerPromise: PromisePair<number> = { promise: null, resolve: null };

export class Bladeburner {
  numHosp = 0;
  moneyLost = 0;
  rank = 0;
  maxRank = 0;

  skillPoints = 0;
  totalSkillPoints = 0;

  teamSize = 0;
  sleeveSize = 0;
  teamLost = 0;

  storedCycles = 0;

  randomEventCounter: number = getRandomInt(240, 600);

  actionTimeToComplete = 0;
  actionTimeCurrent = 0;
  actionTimeOverflow = 0;

  action: ActionIdentifier | null = null;

  cities = createEnumKeyedRecord(CityName, (name) => new City(name));
  city = CityName.Sector12;
  // Todo: better types for all these Record<string, etc> types. Will need custom types or enums for the named string categories (e.g. skills).
  skills: PartialRecord<BladeSkillName, number> = {};
  skillMultipliers: Record<string, number> = {};
  staminaBonus = 0;
  maxStamina = 0;
  stamina = 0;
  // Contracts and operations are stored on the Bladeburner object even though they are global so that they can utilize save/load of the main bladeburner object
  contracts: Record<BladeContractName, Contract>;
  operations: Record<BladeOperationName, Operation>;
  numBlackOpsComplete = 0;
  logging = {
    general: true,
    contracts: true,
    ops: true,
    blackops: true,
    events: true,
  };
  automateEnabled = false;
  automateActionHigh: ActionIdentifier | null = null;
  automateThreshHigh = 0;
  automateActionLow: ActionIdentifier | null = null;
  automateThreshLow = 0;
  consoleHistory: string[] = [];
  consoleLogs: string[] = ["Bladeburner Console", "Type 'help' to see console commands"];

  constructor() {
    this.updateSkillMultipliers(); // Calls resetSkillMultipliers()

    // Max Stamina is based on stats and Bladeburner-specific bonuses
    this.calculateMaxStamina();
    this.stamina = this.maxStamina;
    this.contracts = Contracts || initContracts();
    this.operations = Operations || initOperations();
    this.create();
  }

  getCurrentCity(): City {
    return this.cities[this.city];
  }

  calculateStaminaPenalty(): number {
    if (this.stamina === this.maxStamina) return 1;
    return Math.min(1, this.stamina / (0.5 * this.maxStamina));
  }

  // Todo, deduplicate this functionality
  getNextBlackOp(): { name: BladeBlackOpName; rank: number } | null {
    if (this.numBlackOpsComplete === blackOpsArray.length) return null;
    const blackOp = blackOpsArray[this.numBlackOpsComplete];
    return { name: blackOp.name, rank: blackOp.reqdRank };
  }

  canAttemptBlackOp(blackOpName: BladeBlackOpName): BlackOpsAttempt {
    const blackOp = BlackOperations[blackOpName];
    // Don't repeat BlackOps that are already done
    if (this.numBlackOpsComplete > blackOp.id) {
      return { error: "Tried to start a Black Operation that had already been completed" };
    }

    if (blackOp.reqdRank > this.rank) {
      return { error: "Tried to start a Black Operation without meeting the rank requirement" };
    }

    // Can't start a BlackOp if you haven't done the one before it
    if (this.numBlackOpsComplete < blackOp.id) {
      return { error: `Preceding Black Op must be completed before starting '${blackOp.name}'.` };
    }

    return { isAvailable: true, action: blackOp };
  }

  /** This function is only for the player. Sleeves use their own functions to perform blade work.
   *  Todo: partial unification of player and sleeve methods? */
  startAction(actionId: ActionIdentifier | null): void {
    if (!actionId) return this.resetAction();
    this.action = actionId;
    this.actionTimeCurrent = 0;
    switch (actionId.type) {
      case BladeActionType.contract: {
        const action = this.contracts[actionId.name];
        if (action.count < 1) return this.resetAction();
        this.actionTimeToComplete = action.getActionTime(this, Player);
        return;
      }
      case BladeActionType.operation:
        try {
          const action = this.operations[actionId.name];
          if (action.count < 1) {
            return this.resetAction();
          }
          if (actionId.name === "Raid" && this.getCurrentCity().comms === 0) {
            return this.resetAction();
          }
          this.actionTimeToComplete = action.getActionTime(this, Player);
        } catch (e: unknown) {
          exceptionAlert(e);
        }
        break;
      case BladeActionType.blackOp:
        try {
          const testBlackOp = this.canAttemptBlackOp(actionId.name);
          if (!testBlackOp.isAvailable) {
            this.resetAction();
            this.log(`Error: ${testBlackOp.error}`);
            break;
          }
          if (testBlackOp.action === undefined) {
            throw new Error("action should not be null");
          }
          this.actionTimeToComplete = testBlackOp.action.getActionTime(this, Player);
        } catch (e: unknown) {
          exceptionAlert(e);
        }
        break;
      case BladeActionType.general: {
        const action = GeneralActions[actionId.name];
        this.actionTimeToComplete = action.getActionTime(this, Player);
        return;
      }
      default: {
        const __check: never = actionId;
      }
    }
  }

  setSkillLevel(skillName: BladeSkillName, value: number) {
    this.skills[skillName] = clampInteger(value);
    this.updateSkillMultipliers();
  }

  upgradeSkill(skillName: BladeSkillName, count = 1): void {
    this.setSkillLevel(skillName, (this.skills[skillName] ?? 0) + count);
  }

  executeConsoleCommands(commands: string): void {
    try {
      // Console History
      if (this.consoleHistory[this.consoleHistory.length - 1] != commands) {
        this.consoleHistory.push(commands);
        if (this.consoleHistory.length > 50) {
          this.consoleHistory.splice(0, 1);
        }
      }

      const arrayOfCommands = commands.split(";");
      for (let i = 0; i < arrayOfCommands.length; ++i) {
        this.executeConsoleCommand(arrayOfCommands[i]);
      }
    } catch (e: unknown) {
      exceptionAlert(e);
    }
  }

  postToConsole(input: string, saveToLogs = true): void {
    const MaxConsoleEntries = 100;
    if (saveToLogs) {
      this.consoleLogs.push(input);
      if (this.consoleLogs.length > MaxConsoleEntries) {
        this.consoleLogs.shift();
      }
    }
  }

  log(input: string): void {
    // Adds a timestamp and then just calls postToConsole
    this.postToConsole(`[${getTimestamp()}] ${input}`);
  }

  resetAction(): void {
    this.action = null;
    this.actionTimeCurrent = 0;
    this.actionTimeToComplete = 0;
  }

  clearConsole(): void {
    this.consoleLogs.length = 0;
  }

  prestige(): void {
    this.resetAction();
    const bladeburnerFac = Factions[FactionName.Bladeburners];
    if (this.rank >= BladeburnerConstants.RankNeededForFaction) {
      joinFaction(bladeburnerFac);
    }
  }

  storeCycles(numCycles = 0): void {
    this.storedCycles += numCycles;
  }

  // todo 3.0, remove this fuzz and expect a valid exact action from players
  getActionIdFromTypeAndName(type = "", name = ""): ActionIdentifier | null {
    if (!type || !name) return null;
    const convertedType = type.toLowerCase().trim();
    switch (convertedType) {
      case "contract":
      case "contracts":
      case "contr":
        if (!getEnumHelper("BladeContractName").isMember(name)) return null;
        return { type: BladeActionType.contract, name };
      case "operation":
      case "operations":
      case "op":
      case "ops":
        if (!getEnumHelper("BladeOperationName").isMember(name)) return null;
        return { type: BladeActionType.operation, name };
      case "blackoperation":
      case "black operation":
      case "black operations":
      case "black op":
      case "black ops":
      case "blackop":
      case "blackops":
        if (!getEnumHelper("BladeBlackOpName").isMember(name)) return null;
        return { type: BladeActionType.blackOp, name };
      case "general":
      case "general action":
      case "gen": {
        const actionName = getEnumHelper("BladeGeneralActionName").getMember(name, { fuzzy: true });
        if (!actionName) return null;
        return { type: BladeActionType.general, name: actionName };
      }
      default:
        return null;
    }
  }

  executeStartConsoleCommand(args: string[]): void {
    if (args.length !== 3) {
      this.postToConsole("Invalid usage of 'start' console command: start [type] [name]");
      this.postToConsole("Use 'help start' for more info");
      return;
    }
    const type = args[1];
    const name = args[2];
    const actionId = this.getActionIdFromTypeAndName(type, name);
    if (!actionId) {
      this.postToConsole(`Invalid action type / name specified: type: ${type}, name: ${name}`);
      return;
    }
    this.startAction(actionId);
  }

  executeSkillConsoleCommand(args: string[]): void {
    switch (args.length) {
      case 1: {
        // Display Skill Help Command
        this.postToConsole("Invalid usage of 'skill' console command: skill [action] [name]");
        this.postToConsole("Use 'help skill' for more info");
        break;
      }
      case 2: {
        if (args[1].toLowerCase() === "list") {
          // List all skills and their level
          this.postToConsole("Skills: ");
          for (const skill of Object.values(Skills)) {
            const skillLevel = this.getSkillLevel(skill.name);
            this.postToConsole(`${skill.name}: Level ${formatNumberNoSuffix(skillLevel, 0)}\n\nEffects: `);
          }
          const multKeys = Object.keys(this.skillMultipliers);
          for (let i = 0; i < multKeys.length; ++i) {
            const mult = this.skillMultipliers[multKeys[i]];
            if (mult && mult !== 1) {
              const mults = formatNumberNoSuffix(mult, 3);
              switch (multKeys[i]) {
                case "successChanceAll":
                  this.postToConsole("Total Success Chance: x" + mults);
                  break;
                case "successChanceStealth":
                  this.postToConsole("Stealth Success Chance: x" + mults);
                  break;
                case "successChanceKill":
                  this.postToConsole("Retirement Success Chance: x" + mults);
                  break;
                case "successChanceContract":
                  this.postToConsole("Contract Success Chance: x" + mults);
                  break;
                case "successChanceOperation":
                  this.postToConsole("Operation Success Chance: x" + mults);
                  break;
                case "successChanceEstimate":
                  this.postToConsole("Synthoid Data Estimate: x" + mults);
                  break;
                case "actionTime":
                  this.postToConsole("Action Time: x" + mults);
                  break;
                case "effHack":
                  this.postToConsole("Hacking Skill: x" + mults);
                  break;
                case "effStr":
                  this.postToConsole("Strength: x" + mults);
                  break;
                case "effDef":
                  this.postToConsole("Defense: x" + mults);
                  break;
                case "effDex":
                  this.postToConsole("Dexterity: x" + mults);
                  break;
                case "effAgi":
                  this.postToConsole("Agility: x" + mults);
                  break;
                case "effCha":
                  this.postToConsole("Charisma: x" + mults);
                  break;
                case "effInt":
                  this.postToConsole("Intelligence: x" + mults);
                  break;
                case "stamina":
                  this.postToConsole("Stamina: x" + mults);
                  break;
                default:
                  console.warn(`Unrecognized SkillMult Key: ${multKeys[i]}`);
                  break;
              }
            }
          }
        } else {
          this.postToConsole("Invalid usage of 'skill' console command: skill [action] [name]");
          this.postToConsole("Use 'help skill' for more info");
        }
        break;
      }
      case 3: {
        const skillName = args[2];
        if (!getEnumHelper("BladeSkillName").isMember(skillName)) {
          this.postToConsole("Invalid skill name (Note that it is case-sensitive): " + skillName);
          return;
        }
        const skill = Skills[skillName];
        const level = this.getSkillLevel(skillName);
        if (args[1].toLowerCase() === "list") {
          this.postToConsole(skillName + ": Level " + formatNumberNoSuffix(level));
        } else if (args[1].toLowerCase() === "level") {
          const pointCost = skill.calculateCost(level);
          if (skill.maxLvl !== 0 && level >= skill.maxLvl) {
            this.postToConsole(`This skill ${skillName} is already at max level (${level}/${skill.maxLvl}).`);
          } else if (this.skillPoints >= pointCost) {
            this.skillPoints -= pointCost;
            this.upgradeSkill(skillName);
            this.log(skillName + " upgraded to Level " + this.getSkillLevel(skillName));
          } else {
            this.postToConsole(
              "You do not have enough Skill Points to upgrade this. You need " + formatNumberNoSuffix(pointCost, 0),
            );
          }
        } else {
          this.postToConsole("Invalid usage of 'skill' console command: skill [action] [name]");
          this.postToConsole("Use 'help skill' for more info");
        }
        break;
      }
      default: {
        this.postToConsole("Invalid usage of 'skill' console command: skill [action] [name]");
        this.postToConsole("Use 'help skill' for more info");
        break;
      }
    }
  }

  executeLogConsoleCommand(args: string[]): void {
    if (args.length < 3) {
      this.postToConsole("Invalid usage of log command: log [enable/disable] [action/event]");
      this.postToConsole("Use 'help log' for more details and examples");
      return;
    }

    let flag = true;
    if (args[1].toLowerCase().includes("d")) {
      flag = false;
    } // d for disable

    switch (args[2].toLowerCase()) {
      case "general":
      case "gen":
        this.logging.general = flag;
        this.log("Logging " + (flag ? "enabled" : "disabled") + " for general actions");
        break;
      case "contract":
      case "contracts":
        this.logging.contracts = flag;
        this.log("Logging " + (flag ? "enabled" : "disabled") + " for Contracts");
        break;
      case "ops":
      case "op":
      case "operations":
      case "operation":
        this.logging.ops = flag;
        this.log("Logging " + (flag ? "enabled" : "disabled") + " for Operations");
        break;
      case "blackops":
      case "blackop":
      case "black operations":
      case "black operation":
        this.logging.blackops = flag;
        this.log("Logging " + (flag ? "enabled" : "disabled") + " for BlackOps");
        break;
      case "event":
      case "events":
        this.logging.events = flag;
        this.log("Logging " + (flag ? "enabled" : "disabled") + " for events");
        break;
      case "all":
        this.logging.general = flag;
        this.logging.contracts = flag;
        this.logging.ops = flag;
        this.logging.blackops = flag;
        this.logging.events = flag;
        this.log("Logging " + (flag ? "enabled" : "disabled") + " for everything");
        break;
      default:
        this.postToConsole("Invalid action/event type specified: " + args[2]);
        this.postToConsole(
          "Examples of valid action/event identifiers are: [general, contracts, ops, blackops, events]",
        );
        break;
    }
  }

  executeHelpConsoleCommand(args: string[]): void {
    if (args.length === 1) {
      for (const line of ConsoleHelpText.helpList) {
        this.postToConsole(line);
      }
    } else {
      for (let i = 1; i < args.length; ++i) {
        if (!(args[i] in ConsoleHelpText)) continue;
        const helpText = ConsoleHelpText[args[i]];
        for (const line of helpText) {
          this.postToConsole(line);
        }
      }
    }
  }

  executeAutomateConsoleCommand(args: string[]): void {
    if (args.length !== 2 && args.length !== 4) {
      this.postToConsole(
        "Invalid use of 'automate' command: automate [var] [val] [hi/low]. Use 'help automate' for more info",
      );
      return;
    }

    // Enable/Disable
    if (args.length === 2) {
      const flag = args[1];
      if (flag.toLowerCase() === "status") {
        this.postToConsole("Automation: " + (this.automateEnabled ? "enabled" : "disabled"));
        this.postToConsole(
          "When your stamina drops to " +
            formatNumberNoSuffix(this.automateThreshLow, 0) +
            ", you will automatically switch to " +
            (this.automateActionLow?.name ?? "Idle") +
            ". When your stamina recovers to " +
            formatNumberNoSuffix(this.automateThreshHigh, 0) +
            ", you will automatically " +
            "switch to " +
            (this.automateActionHigh?.name ?? "Idle") +
            ".",
        );
      } else if (flag.toLowerCase().includes("en")) {
        if (!this.automateActionLow || !this.automateActionHigh) {
          return this.log("Failed to enable automation. Actions were not set");
        }
        this.automateEnabled = true;
        this.log("Bladeburner automation enabled");
      } else if (flag.toLowerCase().includes("d")) {
        this.automateEnabled = false;
        this.log("Bladeburner automation disabled");
      } else {
        this.log("Invalid argument for 'automate' console command: " + args[1]);
      }
      return;
    }

    // Set variables
    if (args.length === 4) {
      const type = args[1].toLowerCase(); // allows Action Type to be with or without capitalization.
      const name = args[2];

      let highLow = false; // True for high, false for low
      if (args[3].toLowerCase().includes("hi")) {
        highLow = true;
      }

      let actionId: ActionIdentifier;
      switch (type) {
        case "stamina":
          // For stamina, the "name" variable is actually the stamina threshold
          if (isNaN(parseFloat(name))) {
            this.postToConsole("Invalid value specified for stamina threshold (must be numeric): " + name);
          } else {
            if (highLow) {
              this.automateThreshHigh = Number(name);
            } else {
              this.automateThreshLow = Number(name);
            }
            this.log("Automate (" + (highLow ? "HIGH" : "LOW") + ") stamina threshold set to " + name);
          }
          return;
        case "general":
        case "gen": {
          if (!getEnumHelper("BladeGeneralActionName").isMember(name)) {
            this.postToConsole("Invalid General Action name specified: " + name);
            return;
          }
          actionId = { type: BladeActionType.general, name };
          break;
        }
        case "contract":
        case "contracts": {
          if (!getEnumHelper("BladeContractName").isMember(name)) {
            this.postToConsole("Invalid Contract name specified: " + name);
            return;
          }
          actionId = { type: BladeActionType.contract, name };
          break;
        }
        case "ops":
        case "op":
        case "operations":
        case "operation":
          if (!getEnumHelper("BladeOperationName").isMember(name)) {
            this.postToConsole("Invalid Operation name specified: " + name);
            return;
          }
          actionId = { type: BladeActionType.operation, name };
          break;
        default:
          this.postToConsole("Invalid use of automate command.");
          return;
      }
      if (highLow) {
        this.automateActionHigh = actionId;
      } else {
        this.automateActionLow = actionId;
      }
      this.log("Automate (" + (highLow ? "HIGH" : "LOW") + ") action set to " + name);

      return;
    }
  }

  parseCommandArguments(command: string): string[] {
    /**
     * Returns an array with command and its arguments in each index.
     * e.g. skill "blade's intuition" foo returns [skill, blade's intuition, foo]
     * The input to the fn will be trimmed and will have all whitespace replaced w/ a single space
     */
    const args = [];
    let start = 0;
    let i = 0;
    while (i < command.length) {
      const c = command.charAt(i);
      if (c === '"' || c === "'") {
        // Double quotes or Single quotes
        const endQuote = command.indexOf(c, i + 1);
        if (endQuote !== -1 && (endQuote === command.length - 1 || command.charAt(endQuote + 1) === KEY.SPACE)) {
          args.push(command.substring(i + 1, endQuote - i - 1));
          if (endQuote === command.length - 1) {
            start = i = endQuote + 1;
          } else {
            start = i = endQuote + 2; // Skip the space
          }
          continue;
        }
      } else if (c === KEY.SPACE) {
        args.push(command.substring(start, i - start));
        start = i + 1;
      }
      ++i;
    }
    if (start !== i) {
      args.push(command.substring(start, i - start));
    }
    return args;
  }

  executeConsoleCommand(command: string): void {
    command = command.trim();
    command = command.replace(/\s\s+/g, " "); // Replace all whitespace w/ a single space

    const args = this.parseCommandArguments(command);
    if (args.length <= 0) return; // Log an error?

    switch (args[0].toLowerCase()) {
      case "automate":
        this.executeAutomateConsoleCommand(args);
        break;
      case "clear":
      case "cls":
        this.clearConsole();
        break;
      case "help":
        this.executeHelpConsoleCommand(args);
        break;
      case "log":
        this.executeLogConsoleCommand(args);
        break;
      case "skill":
        this.executeSkillConsoleCommand(args);
        break;
      case "start":
        this.executeStartConsoleCommand(args);
        break;
      case "stop":
        this.resetAction();
        break;
      default:
        this.postToConsole("Invalid console command");
        break;
    }
  }

  triggerMigration(sourceCityName: CityName): void {
    const cityHelper = getEnumHelper("CityName");
    let destCityName = cityHelper.random();
    while (destCityName === sourceCityName) destCityName = cityHelper.random();

    const destCity = this.cities[destCityName];
    const sourceCity = this.cities[sourceCityName];

    const rand = Math.random();
    let percentage = getRandomInt(3, 15) / 100;

    if (rand < 0.05 && sourceCity.comms > 0) {
      // 5% chance for community migration
      percentage *= getRandomInt(2, 4); // Migration increases population change
      --sourceCity.comms;
      ++destCity.comms;
    }
    const count = Math.round(sourceCity.pop * percentage);
    sourceCity.pop -= count;
    destCity.pop += count;
    if (destCity.pop < BladeburnerConstants.PopGrowthCeiling) {
      destCity.pop += BladeburnerConstants.BasePopGrowth;
    }
  }

  triggerPotentialMigration(sourceCityName: CityName, chance: number): void {
    if (chance == null || isNaN(chance)) {
      console.error("Invalid 'chance' parameter passed into Bladeburner.triggerPotentialMigration()");
    }
    if (chance > 1) {
      chance /= 100;
    }
    if (Math.random() < chance) {
      this.triggerMigration(sourceCityName);
    }
  }

  randomEvent(): void {
    const chance = Math.random();
    const cityHelper = getEnumHelper("CityName");

    // Choose random source/destination city for events
    const sourceCityName = cityHelper.random();
    const sourceCity = this.cities[sourceCityName];

    let destCityName = cityHelper.random();
    while (destCityName === sourceCityName) destCityName = cityHelper.random();
    const destCity = this.cities[destCityName];

    if (chance <= 0.05) {
      // New Synthoid Community, 5%
      ++sourceCity.comms;
      const percentage = getRandomInt(10, 20) / 100;
      const count = Math.round(sourceCity.pop * percentage);
      sourceCity.pop += count;
      if (sourceCity.pop < BladeburnerConstants.PopGrowthCeiling) {
        sourceCity.pop += BladeburnerConstants.BasePopGrowth;
      }
      if (this.logging.events) {
        this.log("Intelligence indicates that a new Synthoid community was formed in a city");
      }
    } else if (chance <= 0.1) {
      // Synthoid Community Migration, 5%
      if (sourceCity.comms <= 0) {
        // If no comms in source city, then instead trigger a new Synthoid community event
        ++sourceCity.comms;
        const percentage = getRandomInt(10, 20) / 100;
        const count = Math.round(sourceCity.pop * percentage);
        sourceCity.pop += count;
        if (sourceCity.pop < BladeburnerConstants.PopGrowthCeiling) {
          sourceCity.pop += BladeburnerConstants.BasePopGrowth;
        }
        if (this.logging.events) {
          this.log("Intelligence indicates that a new Synthoid community was formed in a city");
        }
      } else {
        --sourceCity.comms;
        ++destCity.comms;

        // Change pop
        const percentage = getRandomInt(10, 20) / 100;
        const count = Math.round(sourceCity.pop * percentage);
        sourceCity.pop -= count;
        destCity.pop += count;
        if (destCity.pop < BladeburnerConstants.PopGrowthCeiling) {
          destCity.pop += BladeburnerConstants.BasePopGrowth;
        }
        if (this.logging.events) {
          this.log(
            "Intelligence indicates that a Synthoid community migrated from " + sourceCityName + " to some other city",
          );
        }
      }
    } else if (chance <= 0.3) {
      // New Synthoids (non community), 20%
      const percentage = getRandomInt(8, 24) / 100;
      const count = Math.round(sourceCity.pop * percentage);
      sourceCity.pop += count;
      if (sourceCity.pop < BladeburnerConstants.PopGrowthCeiling) {
        sourceCity.pop += BladeburnerConstants.BasePopGrowth;
      }
      if (this.logging.events) {
        this.log(
          "Intelligence indicates that the Synthoid population of " + sourceCityName + " just changed significantly",
        );
      }
    } else if (chance <= 0.5) {
      // Synthoid migration (non community) 20%
      this.triggerMigration(sourceCityName);
      if (this.logging.events) {
        this.log(
          "Intelligence indicates that a large number of Synthoids migrated from " +
            sourceCityName +
            " to some other city",
        );
      }
    } else if (chance <= 0.7) {
      // Synthoid Riots (+chaos), 20%
      sourceCity.chaos += 1;
      sourceCity.chaos *= 1 + getRandomInt(5, 20) / 100;
      if (this.logging.events) {
        this.log("Tensions between Synthoids and humans lead to riots in " + sourceCityName + "! Chaos increased");
      }
    } else if (chance <= 0.9) {
      // Less Synthoids, 20%
      const percentage = getRandomInt(8, 20) / 100;
      const count = Math.round(sourceCity.pop * percentage);
      sourceCity.pop -= count;
      if (this.logging.events) {
        this.log(
          "Intelligence indicates that the Synthoid population of " + sourceCityName + " just changed significantly",
        );
      }
    }
    // 10% chance of nothing happening
  }

  /**
   * Return stat to be gained from Contracts, Operations, and Black Operations
   * @param action(Action obj) - Derived action class
   * @param success(bool) - Whether action was successful
   */
  getActionStats(action: Action, person: Person, success: boolean): WorkStats {
    const difficulty = action.getDifficulty();

    /**
     * Gain multiplier based on difficulty. If it changes then the
     * same variable calculated in completeAction() needs to change too
     */
    const difficultyMult =
      Math.pow(difficulty, BladeburnerConstants.DiffMultExponentialFactor) +
      difficulty / BladeburnerConstants.DiffMultLinearFactor;

    const time = action.getActionTime(this, person);
    const successMult = success ? 1 : 0.5;

    const unweightedGain = time * BladeburnerConstants.BaseStatGain * successMult * difficultyMult;
    const unweightedIntGain = time * BladeburnerConstants.BaseIntGain * successMult * difficultyMult;
    const skillMult = this.skillMultipliers.expGain;

    return {
      hackExp: unweightedGain * action.weights.hack * skillMult,
      strExp: unweightedGain * action.weights.str * skillMult,
      defExp: unweightedGain * action.weights.def * skillMult,
      dexExp: unweightedGain * action.weights.dex * skillMult,
      agiExp: unweightedGain * action.weights.agi * skillMult,
      chaExp: unweightedGain * action.weights.cha * skillMult,
      intExp: unweightedIntGain * action.weights.int * skillMult,
      money: 0,
      reputation: 0,
    };
  }

  getDiplomacyEffectiveness(person: Person): number {
    // Returns a decimal by which the city's chaos level should be multiplied (e.g. 0.98)
    const CharismaLinearFactor = 1e3;
    const CharismaExponentialFactor = 0.045;

    const charismaEff =
      Math.pow(person.skills.charisma, CharismaExponentialFactor) + person.skills.charisma / CharismaLinearFactor;
    return (100 - charismaEff) / 100;
  }

  getRecruitmentSuccessChance(person: Person): number {
    return Math.pow(person.skills.charisma, 0.45) / (this.teamSize - this.sleeveSize + 1);
  }

  getRecruitmentTime(person: Person): number {
    const effCharisma = person.skills.charisma * this.skillMultipliers.effCha;
    const charismaFactor = Math.pow(effCharisma, 0.81) + effCharisma / 90;
    return Math.max(10, Math.round(BladeburnerConstants.BaseRecruitmentTimeNeeded - charismaFactor));
  }

  sleeveSupport(joining: boolean): void {
    if (joining) {
      this.sleeveSize += 1;
      this.teamSize += 1;
    } else {
      this.sleeveSize -= 1;
      this.teamSize -= 1;
    }
  }

  resetSkillMultipliers(): void {
    this.skillMultipliers = {
      successChanceAll: 1,
      successChanceStealth: 1,
      successChanceKill: 1,
      successChanceContract: 1,
      successChanceOperation: 1,
      successChanceEstimate: 1,
      actionTime: 1,
      effHack: 1,
      effStr: 1,
      effDef: 1,
      effDex: 1,
      effAgi: 1,
      effCha: 1,
      effInt: 1,
      stamina: 1,
      money: 1,
      expGain: 1,
    };
  }

  updateSkillMultipliers(): void {
    this.resetSkillMultipliers();
    for (const skill of Object.values(Skills)) {
      const level = this.getSkillLevel(skill.name);
      if (!level) continue;

      const multiplierNames = Object.keys(this.skillMultipliers);
      for (let i = 0; i < multiplierNames.length; ++i) {
        const multiplierName = multiplierNames[i];
        if (skill.getMultiplier(multiplierName) != null && !isNaN(skill.getMultiplier(multiplierName))) {
          const value = skill.getMultiplier(multiplierName) * level;
          let multiplierValue = 1 + value / 100;
          if (multiplierName === "actionTime") {
            multiplierValue = 1 - value / 100;
          }
          this.skillMultipliers[multiplierName] *= multiplierValue;
        }
      }
    }
  }

  completeOperation(success: boolean): void {
    if (this.action?.type !== BladeActionType.operation) {
      throw new Error("completeOperation() called even though current action is not an Operation");
    }
    const action = this.getActionObject(this.action);

    // Calculate team losses
    const teamCount = action.teamCount;
    if (teamCount >= 1) {
      const maxLosses = success ? Math.ceil(teamCount / 2) : Math.floor(teamCount);
      const losses = getRandomInt(0, maxLosses);
      this.teamSize -= losses;
      if (this.teamSize < this.sleeveSize) {
        const sup = Player.sleeves.filter((x) => isSleeveSupportWork(x.currentWork));
        for (let i = 0; i > this.teamSize - this.sleeveSize; i--) {
          const r = Math.floor(Math.random() * sup.length);
          sup[r].takeDamage(sup[r].hp.max);
          sup.splice(r, 1);
        }
        this.teamSize += this.sleeveSize;
      }
      this.teamLost += losses;
      if (this.logging.ops && losses > 0) {
        this.log("Lost " + formatNumberNoSuffix(losses, 0) + " team members during this " + action.name);
      }
    }

    const city = this.getCurrentCity();
    switch (action.name) {
      case BladeOperationName.investigation:
        if (success) {
          city.improvePopulationEstimateByPercentage(0.4 * this.skillMultipliers.successChanceEstimate);
        } else {
          this.triggerPotentialMigration(this.city, 0.1);
        }
        break;
      case BladeOperationName.undercover:
        if (success) {
          city.improvePopulationEstimateByPercentage(0.8 * this.skillMultipliers.successChanceEstimate);
        } else {
          this.triggerPotentialMigration(this.city, 0.15);
        }
        break;
      case BladeOperationName.sting:
        if (success) {
          city.changePopulationByPercentage(-0.1, {
            changeEstEqually: true,
            nonZero: true,
          });
        }
        city.changeChaosByCount(0.1);
        break;
      case BladeOperationName.raid:
        if (success) {
          city.changePopulationByPercentage(-1, {
            changeEstEqually: true,
            nonZero: true,
          });
          --city.comms;
        } else {
          const change = getRandomInt(-10, -5) / 10;
          city.changePopulationByPercentage(change, {
            nonZero: true,
            changeEstEqually: false,
          });
        }
        city.changeChaosByPercentage(getRandomInt(1, 5));
        break;
      case BladeOperationName.stealthRetirement:
        if (success) {
          city.changePopulationByPercentage(-0.5, {
            changeEstEqually: true,
            nonZero: true,
          });
        }
        city.changeChaosByPercentage(getRandomInt(-3, -1));
        break;
      case BladeOperationName.assassination:
        if (success) {
          city.changePopulationByCount(-1, { estChange: -1, estOffset: 0 });
        }
        city.changeChaosByPercentage(getRandomInt(-5, 5));
        break;
      default:
        throw new Error("Invalid Action name in completeOperation: " + this.action.name);
    }
  }

  getActionObject(actionId: ActionIdentifier & { type: BladeActionType.blackOp }): BlackOperation;
  getActionObject(actionId: ActionIdentifier & { type: BladeActionType.operation }): Operation;
  getActionObject(actionId: ActionIdentifier & { type: BladeActionType.contract }): Contract;
  getActionObject(actionId: ActionIdentifier & { type: BladeGeneralActionName }): GeneralAction;
  getActionObject(actionId: ActionIdentifier): Action;
  getActionObject(actionId: ActionIdentifier): Action {
    /**
     * Given an ActionIdentifier object, returns the corresponding
     * GeneralAction, Contract, Operation, or BlackOperation object
     */
    switch (actionId.type) {
      case BladeActionType.contract:
        return this.contracts[actionId.name];
      case BladeActionType.operation:
        return this.operations[actionId.name];
      case BladeActionType.blackOp:
        return BlackOperations[actionId.name];
      case BladeActionType.general:
        return GeneralActions[actionId.name];
    }
  }

  completeContract(success: boolean, actionIdent: ActionIdentifier): void {
    if (actionIdent.type !== BladeActionType.contract) {
      throw new Error("completeContract() called even though current action is not a Contract");
    }
    const city = this.getCurrentCity();
    if (success) {
      switch (actionIdent.name) {
        case BladeContractName.tracking:
          // Increase estimate accuracy by a relatively small amount
          city.improvePopulationEstimateByCount(getRandomInt(100, 1e3) * this.skillMultipliers.successChanceEstimate);
          break;
        case BladeContractName.bountyHunter:
          city.changePopulationByCount(-1, { estChange: -1, estOffset: 0 });
          city.changeChaosByCount(0.02);
          break;
        case BladeContractName.retirement:
          city.changePopulationByCount(-1, { estChange: -1, estOffset: 0 });
          city.changeChaosByCount(0.04);
          break;
        default: {
          // Typecheck verifies that the above switch statement is exhaustive
          const __a: never = actionIdent;
        }
      }
    }
  }

  completeAction(person: Person, actionIdent: ActionIdentifier, isPlayer = true): WorkStats {
    let retValue = newWorkStats();
    const action = this.getActionObject(actionIdent);
    switch (action.type) {
      case BladeActionType.contract:
      case BladeActionType.operation: {
        try {
          const isOperation = action.type === BladeActionType.operation;
          const difficulty = action.getDifficulty();
          const difficultyMultiplier =
            Math.pow(difficulty, BladeburnerConstants.DiffMultExponentialFactor) +
            difficulty / BladeburnerConstants.DiffMultLinearFactor;
          const rewardMultiplier = Math.pow(action.rewardFac, action.level - 1);

          if (isPlayer) {
            // Stamina loss is based on difficulty
            this.stamina -= BladeburnerConstants.BaseStaminaLoss * difficultyMultiplier;
            if (this.stamina < 0) {
              this.stamina = 0;
            }
          }

          // Process Contract/Operation success/failure
          if (action.attempt(this, person)) {
            retValue = this.getActionStats(action, person, true);
            ++action.successes;
            --action.count;

            // Earn money for contracts
            let moneyGain = 0;
            if (!isOperation) {
              moneyGain = BladeburnerConstants.ContractBaseMoneyGain * rewardMultiplier * this.skillMultipliers.money;
              retValue.money = moneyGain;
            }

            if (isOperation) {
              action.setMaxLevel(BladeburnerConstants.OperationSuccessesPerLevel);
            } else {
              action.setMaxLevel(BladeburnerConstants.ContractSuccessesPerLevel);
            }
            if (action.rankGain) {
              const gain = addOffset(action.rankGain * rewardMultiplier * currentNodeMults.BladeburnerRank, 10);
              this.changeRank(person, gain);
              if (isOperation && this.logging.ops) {
                this.log(
                  `${person.whoAmI()}: ${action.name} successfully completed! Gained ${formatBigNumber(gain)} rank`,
                );
              } else if (!isOperation && this.logging.contracts) {
                this.log(
                  `${person.whoAmI()}: ${action.name} contract successfully completed! Gained ` +
                    `${formatBigNumber(gain)} rank and ${formatMoney(moneyGain)}`,
                );
              }
            }
            isOperation ? this.completeOperation(true) : this.completeContract(true, actionIdent);
          } else {
            retValue = this.getActionStats(action, person, false);
            ++action.failures;
            --action.count;
            let loss = 0,
              damage = 0;
            if (action.rankLoss) {
              loss = addOffset(action.rankLoss * rewardMultiplier, 10);
              this.changeRank(person, -1 * loss);
            }
            if (action.hpLoss) {
              damage = action.hpLoss * difficultyMultiplier;
              damage = Math.ceil(addOffset(damage, 10));
              const cost = calculateHospitalizationCost(damage);
              if (person.takeDamage(damage)) {
                ++this.numHosp;
                this.moneyLost += cost;
              }
            }
            let logLossText = "";
            if (loss > 0) {
              logLossText += "Lost " + formatNumberNoSuffix(loss, 3) + " rank. ";
            }
            if (damage > 0) {
              logLossText += "Took " + formatNumberNoSuffix(damage, 0) + " damage.";
            }
            if (isOperation && this.logging.ops) {
              this.log(`${person.whoAmI()}: ` + action.name + " failed! " + logLossText);
            } else if (!isOperation && this.logging.contracts) {
              this.log(`${person.whoAmI()}: ` + action.name + " contract failed! " + logLossText);
            }
            isOperation ? this.completeOperation(false) : this.completeContract(false, actionIdent);
          }
          if (action.autoLevel) {
            action.level = action.maxLevel;
          } // Autolevel
        } catch (e: unknown) {
          exceptionAlert(e);
        }
        break;
      }
      case BladeActionType.blackOp: {
        const difficulty = action.getDifficulty();
        const difficultyMultiplier =
          Math.pow(difficulty, BladeburnerConstants.DiffMultExponentialFactor) +
          difficulty / BladeburnerConstants.DiffMultLinearFactor;

        // Stamina loss is based on difficulty
        this.stamina -= BladeburnerConstants.BaseStaminaLoss * difficultyMultiplier;
        if (this.stamina < 0) {
          this.stamina = 0;
        }

        // Team loss variables
        const teamCount = action.teamCount;
        let teamLossMax;

        if (action.attempt(this, person)) {
          retValue = this.getActionStats(action, person, true);
          this.numBlackOpsComplete++;
          let rankGain = 0;
          if (action.rankGain) {
            rankGain = addOffset(action.rankGain * currentNodeMults.BladeburnerRank, 10);
            this.changeRank(person, rankGain);
          }
          teamLossMax = Math.ceil(teamCount / 2);

          if (this.logging.blackops) {
            this.log(`${person.whoAmI()}: ${action.name} successful! Gained ${formatNumberNoSuffix(rankGain, 1)} rank`);
          }
        } else {
          retValue = this.getActionStats(action, person, false);
          let rankLoss = 0;
          let damage = 0;
          if (action.rankLoss) {
            rankLoss = addOffset(action.rankLoss, 10);
            this.changeRank(person, -1 * rankLoss);
          }
          if (action.hpLoss) {
            damage = action.hpLoss * difficultyMultiplier;
            damage = Math.ceil(addOffset(damage, 10));
            const cost = calculateHospitalizationCost(damage);
            if (person.takeDamage(damage)) {
              ++this.numHosp;
              this.moneyLost += cost;
            }
          }
          teamLossMax = Math.floor(teamCount);

          if (this.logging.blackops) {
            this.log(
              `${person.whoAmI()}: ${action.name} failed! Lost ${formatNumberNoSuffix(
                rankLoss,
                1,
              )} rank and took ${formatNumberNoSuffix(damage, 0)} damage`,
            );
          }
        }

        this.resetAction(); // Stop regardless of success or fail

        // Calculate team losses
        if (teamCount >= 1) {
          const losses = getRandomInt(1, teamLossMax);
          this.teamSize -= losses;
          if (this.teamSize < this.sleeveSize) {
            const sup = Player.sleeves.filter((x) => isSleeveSupportWork(x.currentWork));
            for (let i = 0; i > this.teamSize - this.sleeveSize; i--) {
              const r = Math.floor(Math.random() * sup.length);
              sup[r].takeDamage(sup[r].hp.max);
              sup.splice(r, 1);
            }
            this.teamSize += this.sleeveSize;
          }
          this.teamLost += losses;
          if (this.logging.blackops) {
            this.log(
              `${person.whoAmI()}:  You lost ${formatNumberNoSuffix(losses, 0)} team members during ${action.name}`,
            );
          }
        }
        break;
      }
      case BladeActionType.general:
        switch (action.name) {
          case BladeGeneralActionName.training: {
            this.stamina -= 0.5 * BladeburnerConstants.BaseStaminaLoss;
            const strExpGain = 30 * person.mults.strength_exp,
              defExpGain = 30 * person.mults.defense_exp,
              dexExpGain = 30 * person.mults.dexterity_exp,
              agiExpGain = 30 * person.mults.agility_exp,
              staminaGain = 0.04 * this.skillMultipliers.stamina;
            retValue.strExp = strExpGain;
            retValue.defExp = defExpGain;
            retValue.dexExp = dexExpGain;
            retValue.agiExp = agiExpGain;
            this.staminaBonus += staminaGain;
            if (this.logging.general) {
              this.log(
                `${person.whoAmI()}: ` +
                  "Training completed. Gained: " +
                  formatExp(strExpGain) +
                  " str exp, " +
                  formatExp(defExpGain) +
                  " def exp, " +
                  formatExp(dexExpGain) +
                  " dex exp, " +
                  formatExp(agiExpGain) +
                  " agi exp, " +
                  formatBigNumber(staminaGain) +
                  " max stamina",
              );
            }
            break;
          }
          case BladeGeneralActionName.fieldAnalysis: {
            // Does not use stamina. Effectiveness depends on hacking, int, and cha
            let eff =
              0.04 * Math.pow(person.skills.hacking, 0.3) +
              0.04 * Math.pow(person.skills.intelligence, 0.9) +
              0.02 * Math.pow(person.skills.charisma, 0.3);
            eff *= person.mults.bladeburner_analysis;
            if (isNaN(eff) || eff < 0) {
              throw new Error("Field Analysis Effectiveness calculated to be NaN or negative");
            }
            const hackingExpGain = 20 * person.mults.hacking_exp;
            const charismaExpGain = 20 * person.mults.charisma_exp;
            const rankGain = 0.1 * currentNodeMults.BladeburnerRank;
            retValue.hackExp = hackingExpGain;
            retValue.chaExp = charismaExpGain;
            retValue.intExp = BladeburnerConstants.BaseIntGain;
            this.changeRank(person, rankGain);
            this.getCurrentCity().improvePopulationEstimateByPercentage(
              eff * this.skillMultipliers.successChanceEstimate,
            );
            if (this.logging.general) {
              this.log(
                `${person.whoAmI()}: ` +
                  `Field analysis completed. Gained ${formatBigNumber(rankGain)} rank, ` +
                  `${formatExp(hackingExpGain)} hacking exp, and ` +
                  `${formatExp(charismaExpGain)} charisma exp`,
              );
            }
            break;
          }
          case BladeGeneralActionName.recruitment: {
            const successChance = this.getRecruitmentSuccessChance(person);
            const recruitTime = this.getRecruitmentTime(person) * 1000;
            if (Math.random() < successChance) {
              const expGain = 2 * BladeburnerConstants.BaseStatGain * recruitTime;
              retValue.chaExp = expGain;
              ++this.teamSize;
              if (this.logging.general) {
                this.log(
                  `${person.whoAmI()}: ` +
                    "Successfully recruited a team member! Gained " +
                    formatExp(expGain) +
                    " charisma exp",
                );
              }
            } else {
              const expGain = BladeburnerConstants.BaseStatGain * recruitTime;
              retValue.chaExp = expGain;
              if (this.logging.general) {
                this.log(
                  `${person.whoAmI()}: ` +
                    "Failed to recruit a team member. Gained " +
                    formatExp(expGain) +
                    " charisma exp",
                );
              }
            }
            break;
          }
          case BladeGeneralActionName.diplomacy: {
            const eff = this.getDiplomacyEffectiveness(person);
            this.getCurrentCity().chaos *= eff;
            if (this.getCurrentCity().chaos < 0) {
              this.getCurrentCity().chaos = 0;
            }
            if (this.logging.general) {
              this.log(
                `${person.whoAmI()}: Diplomacy completed. Chaos levels in the current city fell by ${formatPercent(
                  1 - eff,
                )}`,
              );
            }
            break;
          }
          case BladeGeneralActionName.hyperbolicRegen: {
            person.regenerateHp(BladeburnerConstants.HrcHpGain);

            const staminaGain = this.maxStamina * (BladeburnerConstants.HrcStaminaGain / 100);
            this.stamina = Math.min(this.maxStamina, this.stamina + staminaGain);
            if (this.logging.general) {
              this.log(
                `${person.whoAmI()}: Rested in Hyperbolic Regeneration Chamber. Restored ${
                  BladeburnerConstants.HrcHpGain
                } HP and gained ${formatStamina(staminaGain)} stamina`,
              );
            }
            break;
          }
          case BladeGeneralActionName.inciteViolence: {
            for (const contract of Object.values(this.contracts)) {
              contract.count += (60 * 3 * contract.growthFunction()) / BladeburnerConstants.ActionCountGrowthPeriod;
            }
            for (const operation of Object.values(this.operations)) {
              operation.count += (60 * 3 * operation.growthFunction()) / BladeburnerConstants.ActionCountGrowthPeriod;
            }
            if (this.logging.general) {
              this.log(`${person.whoAmI()}: Incited violence in the synthoid communities.`);
            }
            for (const cityName of Object.values(CityName)) {
              const city = this.cities[cityName];
              city.chaos += 10;
              city.chaos += city.chaos / (Math.log(city.chaos) / Math.log(10));
            }
            break;
          }
          default: {
            // Verify general actions switch statement is exhaustive
            const __a: never = action;
          }
        }
        break;
      default: {
        // Verify type switch statement is exhaustive
        const __a: never = action;
      }
    }
    return retValue;
  }

  infiltrateSynthoidCommunities(): void {
    const infilSleeves = Player.sleeves.filter((s) => isSleeveInfiltrateWork(s.currentWork)).length;
    const amt = Math.pow(infilSleeves, -0.5) / 2;
    for (const contract of Object.values(BladeContractName)) {
      this.contracts[contract].count += amt;
    }
    for (const operation of Object.values(BladeOperationName)) {
      this.operations[operation].count += amt;
    }
    if (this.logging.general) {
      this.log(`Sleeve: Infiltrate the synthoid communities.`);
    }
  }

  changeRank(person: Person, change: number): void {
    if (isNaN(change)) {
      throw new Error("NaN passed into Bladeburner.changeRank()");
    }
    this.rank += change;
    if (this.rank < 0) {
      this.rank = 0;
    }
    this.maxRank = Math.max(this.rank, this.maxRank);

    const bladeburnersFactionName = FactionName.Bladeburners;
    const bladeburnerFac = Factions[bladeburnersFactionName];
    if (bladeburnerFac.isMember) {
      const favorBonus = 1 + bladeburnerFac.favor / 100;
      bladeburnerFac.playerReputation +=
        BladeburnerConstants.RankToFactionRepFactor * change * person.mults.faction_rep * favorBonus;
    }

    // Gain skill points
    const rankNeededForSp = (this.totalSkillPoints + 1) * BladeburnerConstants.RanksPerSkillPoint;
    if (this.maxRank >= rankNeededForSp) {
      // Calculate how many skill points to gain
      const gainedSkillPoints = Math.floor(
        (this.maxRank - rankNeededForSp) / BladeburnerConstants.RanksPerSkillPoint + 1,
      );
      this.skillPoints += gainedSkillPoints;
      this.totalSkillPoints += gainedSkillPoints;
    }
  }

  processAction(seconds: number): void {
    if (!this.action) return; // Idle
    if (this.actionTimeToComplete <= 0) {
      throw new Error(`Invalid actionTimeToComplete value: ${this.actionTimeToComplete}, type; ${this.action.type}`);
    }
    //Check to see if action is a contract, and then to verify a sleeve didn't finish it first
    if (this.action.type === BladeActionType.contract) {
      const remainingActions = this.contracts[this.action.name].count;
      if (remainingActions < 1) {
        return this.resetAction();
      }
    }
    // If the previous action went past its completion time, add to the next action
    // This is not added immediately in case the automation changes the action
    this.actionTimeCurrent += seconds + this.actionTimeOverflow;
    this.actionTimeOverflow = 0;
    if (this.actionTimeCurrent >= this.actionTimeToComplete) {
      this.actionTimeOverflow = this.actionTimeCurrent - this.actionTimeToComplete;
      const retValue = this.completeAction(Player, this.action);
      Player.gainMoney(retValue.money, "bladeburner");
      Player.gainStats(retValue);
      // Operation Daedalus
      if (this.action.type != BladeActionType.blackOp) {
        this.startAction(this.action); // Repeat action
      }
    }
  }

  calculateStaminaGainPerSecond(): number {
    const effAgility = Player.skills.agility * this.skillMultipliers.effAgi;
    const maxStaminaBonus = this.maxStamina / BladeburnerConstants.MaxStaminaToGainFactor;
    const gain = (BladeburnerConstants.StaminaGainPerSecond + maxStaminaBonus) * Math.pow(effAgility, 0.17);
    return gain * (this.skillMultipliers.stamina * Player.mults.bladeburner_stamina_gain);
  }

  calculateMaxStamina(): void {
    const effAgility = Player.skills.agility * this.skillMultipliers.effAgi;
    const maxStamina =
      (Math.pow(effAgility, 0.8) + this.staminaBonus) *
      this.skillMultipliers.stamina *
      Player.mults.bladeburner_max_stamina;
    if (this.maxStamina !== maxStamina) {
      const oldMax = this.maxStamina;
      this.maxStamina = maxStamina;
      this.stamina = (this.maxStamina * this.stamina) / oldMax;
    }
    if (isNaN(maxStamina)) {
      throw new Error("Max Stamina calculated to be NaN in Bladeburner.calculateMaxStamina()");
    }
  }

  getSkillLevel(skillName: BladeSkillName): number {
    return this.skills[skillName] ?? 0;
  }

  create(): void {
    for (const contract of Object.values(this.contracts)) contract.reset();
    for (const operation of Object.values(this.operations)) operation.reset();
  }

  process(): void {
    // Edge race condition when the engine checks the processing counters and attempts to route before the router is initialized.
    if (!Router.isInitialized) return;

    // If the Player starts doing some other actions, set action to idle and alert
    if (!Player.hasAugmentation(AugmentationName.BladesSimulacrum, true) && Player.currentWork) {
      if (this.action) {
        let msg = "Your Bladeburner action was cancelled because you started doing something else.";
        if (this.automateEnabled) {
          msg += `\n\nYour automation was disabled as well. You will have to re-enable it through the Bladeburner console`;
          this.automateEnabled = false;
        }
        if (!Settings.SuppressBladeburnerPopup) {
          dialogBoxCreate(msg);
        }
      }
      this.resetAction();
    }

    // If the Player has no Stamina, set action to idle
    if (this.stamina <= 0) {
      this.log("Your Bladeburner action was cancelled because your stamina hit 0");
      this.resetAction();
    }

    // A 'tick' for this mechanic is one second (= 5 game cycles)
    if (this.storedCycles >= BladeburnerConstants.CyclesPerSecond) {
      let seconds = Math.floor(this.storedCycles / BladeburnerConstants.CyclesPerSecond);
      seconds = Math.min(seconds, 5); // Max of 5 'ticks'
      this.storedCycles -= seconds * BladeburnerConstants.CyclesPerSecond;

      // Stamina
      this.calculateMaxStamina();
      this.stamina += this.calculateStaminaGainPerSecond() * seconds;
      this.stamina = Math.min(this.maxStamina, this.stamina);

      // Count increase for contracts/operations
      for (const contract of Object.values(this.contracts)) {
        contract.count += (seconds * contract.growthFunction()) / BladeburnerConstants.ActionCountGrowthPeriod;
      }
      for (const op of Object.values(this.operations)) {
        op.count += (seconds * op.growthFunction()) / BladeburnerConstants.ActionCountGrowthPeriod;
      }

      // Chaos goes down very slowly
      for (const cityName of Object.values(CityName)) {
        const city = this.cities[cityName];
        if (!city) throw new Error("Invalid city when processing passive chaos reduction in Bladeburner.process");
        city.chaos -= 0.0001 * seconds;
        city.chaos = Math.max(0, city.chaos);
      }

      // Random Events
      this.randomEventCounter -= seconds;
      if (this.randomEventCounter <= 0) {
        this.randomEvent();
        // Add instead of setting because we might have gone over the required time for the event
        this.randomEventCounter += getRandomInt(240, 600);
      }

      this.processAction(seconds);

      // Automation
      if (this.automateEnabled) {
        // Note: Do NOT set this.action = this.automateActionHigh/Low since it creates a reference
        if (this.stamina <= this.automateThreshLow && this.action?.name !== this.automateActionLow?.name) {
          this.startAction(this.automateActionLow);
        } else if (this.stamina >= this.automateThreshHigh && this.action?.name !== this.automateActionHigh?.name) {
          this.startAction(this.automateActionHigh);
        }
      }

      // Handle "nextUpdate" resolver after this update
      if (BladeburnerPromise.resolve) {
        BladeburnerPromise.resolve(seconds * 1000);
        BladeburnerPromise.resolve = null;
        BladeburnerPromise.promise = null;
      }
    }
  }

  startActionNetscriptFn(type: string, name: string, workerScript: WorkerScript): boolean {
    const errorLogText = `Invalid action: type='${type}' name='${name}'`;
    const actionId = this.getActionIdFromTypeAndName(type, name);
    if (actionId == null) {
      workerScript.log("bladeburner.startAction", () => errorLogText);
      return false;
    }

    // Special logic for Black Ops
    if (actionId.type === BladeActionType.blackOp) {
      const canRunOp = this.canAttemptBlackOp(actionId.name);
      if (!canRunOp.isAvailable) {
        workerScript.log("bladeburner.startAction", () => canRunOp.error + "");
        return false;
      }
    }

    try {
      this.startAction(actionId);
      if (!Player.hasAugmentation(AugmentationName.BladesSimulacrum, true)) Player.finishWork(true);
      workerScript.log(
        "bladeburner.startAction",
        () => `Starting bladeburner action with type '${type}' and name '${name}'`,
      );
      return true;
    } catch (e: unknown) {
      console.error(e);
      this.resetAction();
      workerScript.log("bladeburner.startAction", () => errorLogText);
      return false;
    }
  }

  getActionTimeNetscriptFn(person: Person, type: string, name: string): number | string {
    const actionId = this.getActionIdFromTypeAndName(type, name);
    if (!actionId) return "bladeburner.getActionTime";

    const actionObj = this.getActionObject(actionId);
    return actionObj.getActionTime(this, person) * 1000;
  }

  getActionEstimatedSuccessChanceNetscriptFn(person: Person, type: string, name: string): [number, number] | string {
    const actionId = this.getActionIdFromTypeAndName(type, name);
    if (!actionId) return "bladeburner.getActionEstimatedSuccessChance";

    const actionObj = this.getActionObject(actionId);
    switch (actionId.type) {
      case BladeActionType.contract:
      case BladeActionType.operation:
      case BladeActionType.blackOp:
        return actionObj.getEstSuccessChance(this, person);
      case BladeActionType.general:
        switch (actionId.name) {
          case BladeGeneralActionName.training:
          case BladeGeneralActionName.fieldAnalysis:
          case BladeGeneralActionName.diplomacy:
          case BladeGeneralActionName.hyperbolicRegen:
          case BladeGeneralActionName.inciteViolence:
            return [1, 1];
          case BladeGeneralActionName.recruitment: {
            const recruitChance = this.getRecruitmentSuccessChance(person);
            return [recruitChance, recruitChance];
          }
        }
    }
  }

  getActionCountRemainingNetscriptFn(type: string, name: string, workerScript: WorkerScript): number {
    const errorLogText = `Invalid action: type='${type}' name='${name}'`;
    const actionId = this.getActionIdFromTypeAndName(type, name);
    if (!actionId) {
      workerScript.log("bladeburner.getActionCountRemaining", () => errorLogText);
      return -1;
    }

    const actionObj = this.getActionObject(actionId);
    switch (actionObj.type) {
      case BladeActionType.contract:
      case BladeActionType.operation:
        return actionObj.count;
      case BladeActionType.blackOp:
        return actionObj.id <= this.numBlackOpsComplete ? 1 : 0;
      case BladeActionType.general:
        return Infinity;
    }
  }

  upgradeSkillNetscriptFn(ctx: NetscriptContext, skillName: BladeSkillName, count: PositiveInteger): boolean {
    const skill = Skills[skillName];
    const skillLevel = this.getSkillLevel(skillName);
    const cost = skill.calculateCost(skillLevel, count);

    if (!Number.isFinite(cost)) {
      helpers.log(ctx, () => `Skill '${skillName}' cannot be upgraded ${count} time(s).`);
      return false;
    }

    if (this.skillPoints < cost) {
      helpers.log(
        ctx,
        () =>
          `You do not have enough skill points to upgrade ${skillName} ${count} time(s). (You have ${this.skillPoints}, you need ${cost})`,
      );
      return false;
    }

    this.skillPoints -= cost;
    this.upgradeSkill(skillName, count);
    helpers.log(ctx, () => `'${skillName}' upgraded to level ${this.getSkillLevel(skillName)}`);
    return true;
  }

  getTeamSizeNetscriptFn(type: string, name: string, workerScript: WorkerScript): number {
    if (type === "" && name === "") {
      return this.teamSize;
    }

    const errorLogText = `Invalid action: type='${type}' name='${name}'`;
    const actionId = this.getActionIdFromTypeAndName(type, name);
    if (!actionId) {
      workerScript.log("bladeburner.getTeamSize", () => errorLogText);
      return -1;
    }

    const action = this.getActionObject(actionId);
    return action.type === BladeActionType.operation || action.type === BladeActionType.blackOp ? action.teamCount : 0;
  }

  setTeamSizeNetscriptFn(type: string, name: string, size: number, workerScript: WorkerScript): number {
    const errorLogText = `Invalid action: type='${type}' name='${name}'`;
    const actionId = this.getActionIdFromTypeAndName(type, name);
    if (actionId == null) {
      workerScript.log("bladeburner.setTeamSize", () => errorLogText);
      return -1;
    }
    const action = this.getActionObject(actionId);

    if (action.type !== BladeActionType.operation && action.type !== BladeActionType.blackOp) {
      workerScript.log("bladeburner.setTeamSize", () => "Only valid for 'Operations' and 'BlackOps'");
      return -1;
    }

    let sanitizedSize = Math.round(size);
    if (isNaN(sanitizedSize) || sanitizedSize < 0) {
      workerScript.log("bladeburner.setTeamSize", () => `Invalid size: ${size}`);
      return -1;
    }
    if (this.teamSize < sanitizedSize) {
      sanitizedSize = this.teamSize;
    }
    action.teamCount = sanitizedSize;
    workerScript.log("bladeburner.setTeamSize", () => `Team size for '${name}' set to ${sanitizedSize}.`);
    return sanitizedSize;
  }

  joinBladeburnerFactionNetscriptFn(workerScript: WorkerScript): boolean {
    const bladeburnerFac = Factions[FactionName.Bladeburners];
    if (bladeburnerFac.isMember) {
      return true;
    } else if (this.rank >= BladeburnerConstants.RankNeededForFaction) {
      joinFaction(bladeburnerFac);
      workerScript.log("bladeburner.joinBladeburnerFaction", () => `Joined ${FactionName.Bladeburners} faction.`);
      return true;
    } else {
      workerScript.log(
        "bladeburner.joinBladeburnerFaction",
        () => `You do not have the required rank (${this.rank}/${BladeburnerConstants.RankNeededForFaction}).`,
      );
      return false;
    }
  }

  /** Serialize the current object to a JSON save state. */
  toJSON(): IReviverValue {
    return Generic_toJSON("Bladeburner", this);
  }

  /** Initializes a Bladeburner object from a JSON save state. */
  static fromJSON(value: IReviverValue): Bladeburner {
    const bladeburner = Generic_fromJSON(Bladeburner, value.data);
    return bladeburner;
  }
}

constructorsForReviver.Bladeburner = Bladeburner;
