<!-- Do not edit this file. It is automatically generated by API Documenter. -->

[Home](./index.md) &gt; [bitburner](./bitburner.md) &gt; [Bladeburner](./bitburner.bladeburner.md) &gt; [getActionCountRemaining](./bitburner.bladeburner.getactioncountremaining.md)

## Bladeburner.getActionCountRemaining() method

Get action count remaining.

<b>Signature:</b>

```typescript
getActionCountRemaining(type: string, name: string): number;
```

## Parameters

|  Parameter | Type | Description |
|  --- | --- | --- |
|  type | string | Type of action. |
|  name | string | Name of action. Must be an exact match. |

<b>Returns:</b>

number

Remaining count of the specified action.

## Remarks

RAM cost: 4 GB

Returns the remaining count of the specified action.

Note that this is meant to be used for Contracts and Operations. This function will return ‘Infinity’ for actions such as Training and Field Analysis. This function will return 1 for BlackOps not yet completed regardless of whether the player has the required rank to attempt the mission or not.
