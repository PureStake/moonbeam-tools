import type {
  DispatchError,
  DispatchInfo,
  EventRecord,
  Extrinsic,
  InclusionFee,
} from "@polkadot/types/interfaces";
import type { u128 } from "@polkadot/types";
import { BN } from "@polkadot/util";
import type { FrameSupportWeightsWeightToFeeCoefficient } from "@polkadot/types/lookup";

import type { TxWithEvent } from "@polkadot/api-derive/types";

export interface ComputedFees {
  baseFee: bigint;
  lenFee: bigint;
  weightFee: bigint;
  totalFees: bigint;
}
export interface TxWithEventAndFee extends TxWithEvent {
  fees: ComputedFees;
}

export function mapExtrinsics(
  extrinsics: Extrinsic[],
  records: EventRecord[],
  fees: InclusionFee[],
  feeMultiplier: u128,
  weightToFee: FrameSupportWeightsWeightToFeeCoefficient
): TxWithEventAndFee[] {
  return extrinsics.map((extrinsic, index): TxWithEventAndFee => {
    let dispatchError: DispatchError | undefined;
    let dispatchInfo: DispatchInfo | undefined;

    const events = records
      .filter(({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(index))
      .map(({ event }) => {
        if (event.section === "system") {
          if (event.method === "ExtrinsicSuccess") {
            dispatchInfo = event.data[0] as DispatchInfo;
          } else if (event.method === "ExtrinsicFailed") {
            dispatchError = event.data[0] as DispatchError;
            dispatchInfo = event.data[1] as DispatchInfo;
          }
        }

        return event;
      });

    let computedFees: ComputedFees;
    const feeDetails = fees[index];

    const frac = weightToFee.coeffFrac.mul(dispatchInfo.weight);
    const integer = weightToFee.coeffInteger.mul(dispatchInfo.weight);

    const unadjustedFee = frac.add(integer);

    const adjustedFee = BigInt(unadjustedFee
      .mul(feeMultiplier.toBn())
      .div(new BN("1000000000000000000")).toString());

    computedFees = {
      baseFee: feeDetails.baseFee.toBigInt(),
      lenFee: feeDetails.lenFee.toBigInt(),
      weightFee: adjustedFee,
      totalFees: adjustedFee + feeDetails.baseFee.toBigInt() + feeDetails.lenFee.toBigInt(),
    };
    return { dispatchError, dispatchInfo, events, extrinsic, fees: computedFees };
  });
}
