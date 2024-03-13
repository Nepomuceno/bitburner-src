import * as React from "react";
import { Button, Typography } from "@mui/material";
import { FactionName } from "@enums";
import { BlackOpList } from "./BlackOpList";
import { Bladeburner } from "../Bladeburner";
import { Router } from "../../ui/GameRoot";
import { Page } from "../../ui/Router";
import { CorruptableText } from "../../ui/React/CorruptableText";
import { blackOpsArray } from "../BlackOperations";

interface BlackOpPageProps {
  bladeburner: Bladeburner;
}

export function BlackOpPage({ bladeburner }: BlackOpPageProps): React.ReactElement {
  return (
    <>
      <Typography>
        Black Operations (Black Ops) are special, one-time covert operations. Each Black Op must be unlocked
        successively by completing the one before it.
        <br />
        <br />
        <b>
          Your ultimate goal to climb through the ranks of {FactionName.Bladeburners} is to complete all of the Black
          Ops.
        </b>
        <br />
        <br />
        Like normal operations, you may use a team for Black Ops. Failing a black op will incur heavy HP and rank
        losses.
      </Typography>
      {bladeburner.numBlackOpsComplete >= blackOpsArray.length ? (
        <Button sx={{ my: 1, p: 1 }} onClick={() => Router.toPage(Page.BitVerse, { flume: false, quick: false })}>
          <CorruptableText content="Destroy w0rld_d34mon" spoiler={false}></CorruptableText>
        </Button>
      ) : (
        <BlackOpList bladeburner={bladeburner} />
      )}
    </>
  );
}
