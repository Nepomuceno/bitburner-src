import React from "react";
import { Button, Typography } from "@mui/material";
import { CityName } from "@enums";
import { Bladeburner } from "../Bladeburner";
import { WorldMap } from "../../ui/React/WorldMap";
import { Modal } from "../../ui/React/Modal";
import { Settings } from "../../Settings/Settings";

interface IProps {
  bladeburner: Bladeburner;
  open: boolean;
  onClose: () => void;
}

export function TravelModal(props: IProps): React.ReactElement {
  function travel(city: CityName): void {
    props.bladeburner.city = city;
    props.onClose();
  }

  return (
    <Modal open={props.open} onClose={props.onClose}>
      <>
        <Typography>
          Travel to a different city for your Bladeburner activities. This does not cost any money. The city you are in
          for your Bladeburner duties does not affect your location in the game otherwise.
        </Typography>
        {Settings.DisableASCIIArt ? (
          Object.values(CityName).map((city) => (
            <Button key={city} onClick={() => travel(city)}>
              {city}
            </Button>
          ))
        ) : (
          <WorldMap currentCity={props.bladeburner.city} onTravel={travel} />
        )}
      </>
    </Modal>
  );
}
