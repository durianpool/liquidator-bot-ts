import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

import {
  AppConfig,
  TransactionBuilder,
  UserInfo,
  TokenID,
  LIQUIDATION_LIMIT,
} from '@apricot-lend/sdk-ts';
import { PoolIdToPrice } from './types';
import { LiquidatorBot } from '.';
import { ASSOCIATED_TOKEN_PROGRAM_ID, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as swappers from '@apricot-lend/solana-swaps-js';
import invariant from 'tiny-invariant';

type PoolIdToNum = Record<number, number>;

const sendAndConfirm = async (connection:Connection, tx: Transaction, signers: Keypair[]) => {
  const sig = await connection.sendTransaction(tx, signers, {preflightCommitment: 'confirmed'});
  return await connection.confirmTransaction(sig, 'confirmed');
}

export class LiquidationPlanner {
  private poolIdToBorrowVal: PoolIdToNum;
  private poolIdToDepositVal: PoolIdToNum;

  constructor(
    public bot: LiquidatorBot,
    public config: AppConfig,
    public user_info: UserInfo,
    public walletKey: PublicKey,
    public poolIdToPrice: PoolIdToPrice,
  ) {
    this.poolIdToBorrowVal = {};
    this.poolIdToDepositVal = {};
    const poolIdList = config.getPoolIdList();
    // initialize borrowval and depositval to 0 for all pools
    poolIdList.forEach(poolId => {
      this.poolIdToBorrowVal[poolId] = 0;
      this.poolIdToDepositVal[poolId] = 0;
    });
    // initialize poolIdToBorrowVal and poolIdToDepositVal
    for (const uai of user_info.user_asset_info) {
      const poolId = uai.pool_id;
      const price = poolIdToPrice[poolId];
      if (price === undefined) continue;
      const decimalMult = config.getDecimalMultByPoolId(poolId);
      const depositVal = (price * Math.floor(uai.deposit_amount.toNumber())) / decimalMult;
      const borrowVal = (price * Math.floor(uai.borrow_amount.toNumber())) / decimalMult;
      this.poolIdToDepositVal[poolId] = depositVal;
      this.poolIdToBorrowVal[poolId] = borrowVal;
    }
  }
  canLiquidateAsset(poolId: number): boolean {
    const poolConfig = this.config.getPoolConfigByPoolId(poolId);
    const excludedList = [TokenID.APT];
    const isExcluded = excludedList.includes(poolConfig.tokenId);
    return !isExcluded;
  }
  getBorrowLimitAndBorrow() {
    let [borrowLimit, totalBorrow] = [0, 0];
    const poolIdList = this.config.getPoolIdList();
    poolIdList.forEach(poolId => {
      const ltv = this.config.getLtvByPoolId(poolId)!;
      const depositVal = this.poolIdToDepositVal[poolId];
      const borrowVal = this.poolIdToBorrowVal[poolId];
      borrowLimit += depositVal * ltv;
      totalBorrow += borrowVal;
    });
    const poolIdToBorrowVal = this.poolIdToBorrowVal;
    const poolIdToDepositVal = this.poolIdToDepositVal;
    return { borrowLimit, totalBorrow, poolIdToBorrowVal, poolIdToDepositVal };
  }
  getBorrowProgress(): number | null {
    /*
      returns null if user has no borrow/deposit
      otherwise returns collateral ratio
      */
    if (this.user_info === null) {
      return null;
    }
    const { borrowLimit, totalBorrow } = this.getBorrowLimitAndBorrow();
    if (totalBorrow === 0 || borrowLimit === 0) return null;
    return totalBorrow / borrowLimit;
  }
  getLiquidationSizes(collateralPoolIdVal: [number, number], borrowedPoolIdVal: [number, number]) {
    const [collateralPoolId, collateralVal] = collateralPoolIdVal;
    const [borrowedPoolId, borrowedVal] = borrowedPoolIdVal;
    const postFactor = 0.9;
    const ltv = this.config.getLtvByPoolId(collateralPoolId)!;
    const { borrowLimit, totalBorrow } = this.getBorrowLimitAndBorrow();
    // We need to sell/redeem X USD of asset and use it to repay our debt. To compute X:
    // (totalBorrow-X) / (borrowLimit - X*ltv) ~= postFactor
    // (totalBorrow-X)  ~= (borrowLimit - X*ltv) * postFactor
    // (1 - ltv * postFactor) * X ~= totalBorrow - borrowLimit * postFactor
    // X ~= (totalBorrow - borrowLimit * post_factor ) / (1 - ltv * post_factor)
    const X = (totalBorrow - borrowLimit * postFactor) / (1 - postFactor * ltv);

    const liquidatableVal = Math.min(collateralVal, borrowedVal, X, this.bot.maxLiquidationSize * 1e9);
    const collateralPrice = this.poolIdToPrice[collateralPoolId];
    const borrowedPrice = this.poolIdToPrice[borrowedPoolId];

    const discount = this.config.getPoolConfigByPoolId(collateralPoolId).liquidationDiscount;
    
    const minCollateralAmt = liquidatableVal / collateralPrice * 0.999;
    const borrowedRepayAmt = liquidatableVal / borrowedPrice / (1 + discount);

    return [minCollateralAmt, borrowedRepayAmt];
  }

  pickLiquidationAction(): [number, number, number, number] {

    const filteredPoolIdToDepositVal: PoolIdToNum = {};
    for (const poolIdStr in this.poolIdToDepositVal) {
      const poolId = parseInt(poolIdStr);
      if (this.canLiquidateAsset(poolId)) {
        filteredPoolIdToDepositVal[poolId] = this.poolIdToDepositVal[poolId];
      }
    }

    // pick most-valued collateral and most-valued borrowed asset
    const sortedCollateralVals = Object.entries(filteredPoolIdToDepositVal).sort((kv1,kv2)=>{
      return kv2[1] - kv1[1];
    });
    const sortedBorrowedVals = Object.entries(this.poolIdToBorrowVal).sort((kv1,kv2)=>{
      return kv2[1] - kv1[1];
    });
    // force types to [number, number]
    const pickedCollateralVals:[number, number] = [parseInt(sortedCollateralVals[0][0]), sortedCollateralVals[0][1]];
    const pickedBorrowedVals:[number, number] = [parseInt(sortedBorrowedVals[0][0]), sortedBorrowedVals[0][1]];
    const [collateralMinGetAmt, borrowedRepayAmt] = this.getLiquidationSizes(pickedCollateralVals, pickedBorrowedVals);
    return [
      pickedCollateralVals[0], collateralMinGetAmt,
      pickedBorrowedVals[0], borrowedRepayAmt,
    ];
  }

  shouldLiquidate(): boolean {
    const progress = this.getBorrowProgress();
    return progress !== null && progress > LIQUIDATION_LIMIT.toNumber();
  }

  async fireLiquidation(
    builder: TransactionBuilder,
    connection: Connection,
    liquidatorKeypair: Keypair,
    supportedMarkets: {[key in TokenID]? : swappers.Swapper},
    tokenIdTranslation: {[key in TokenID]? : swappers.TokenID},
  ) {
    // should we fire?
    if (!this.shouldLiquidate()) {
      return;
    }

    const [collateralPoolId, collateralAmt, borrowedPoolId, borrowedAmt] = this.pickLiquidationAction();
    const collateralMint = this.config.getMintByPoolId(collateralPoolId)!;
    const collateralTokId = this.config.getTokenIdByPoolId(collateralPoolId);
    const borrowedMint = this.config.getMintByPoolId(borrowedPoolId)!;
    const borrowedTokId = this.config.getTokenIdByPoolId(borrowedPoolId);

    const usdcPoolId = this.config.tokenIdToPoolId[TokenID.USDC]!;

    const collateralSplKey = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID, 
      TOKEN_PROGRAM_ID, 
      collateralMint, 
      liquidatorKeypair.publicKey
    );
    const usdcSplKey = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID, 
      TOKEN_PROGRAM_ID, 
      this.config.mints[TokenID.USDC], 
      liquidatorKeypair.publicKey
    );
    const borrowedSplKey = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID, 
      TOKEN_PROGRAM_ID, 
      borrowedMint, 
      liquidatorKeypair.
      publicKey
    );
    try{
      this.bot.logAction(`Firing liquidation for ${this.walletKey.toString()}`);
      /*
      three things:
      1. (optional) if repaid token isn't USDC, use inventory USDC to buy repaid token
      2. liquidate, receive collateral
      3. (optional) if received collateral isn't USDC, sell it to USDC

      When there are only <=2 instructions, group them into a single transaction.

      When there are 3 instructions, group 1&2 into a single transaction, and fire 3 separately

      There's a problem with these 3 steps, though:
      - we sell 1.02 X USDC to 1.0 X repaied token
      - we use 1.0 X repaid token to get 1.0 Y received collateral
      - we sell 1.0 Y received collateral back to USDC

      What if we got more repaid token than we want in step 1?
      */
      let instructions: TransactionInstruction[] = [];
      // 1. Use USDC to buy borrowed token
      if (borrowedTokId != TokenID.USDC) {
        if(!(borrowedTokId in supportedMarkets)) {
          throw new Error(`Unsupported borrowed type of ${borrowedTokId}!`);
        }
        const usdcAmount = borrowedAmt * this.poolIdToPrice[borrowedPoolId] / this.poolIdToPrice[usdcPoolId];
        invariant(usdcAmount >= 0);

        const swapper = supportedMarkets[borrowedTokId];
        invariant(swapper !== undefined);

        const borrowedTokIdSwappers = tokenIdTranslation[borrowedTokId];
        invariant(borrowedTokIdSwappers !== undefined);

        const payUsdcAmt = usdcAmount * this.config.getDecimalMultByPoolId(usdcPoolId) * (1 + this.bot.maxTradeSlippage);
        const minAskAmt = borrowedAmt * this.config.getDecimalMultByPoolId(borrowedPoolId);

        this.bot.logAction(`Paying ${payUsdcAmt} USDC for ${minAskAmt} ${borrowedTokIdSwappers}`);

        instructions.push(
          (await swapper.createSwapInstructions(
            swappers.TokenID.USDC,
            Math.ceil(payUsdcAmt),
            usdcSplKey,

            borrowedTokIdSwappers,
            Math.floor(minAskAmt),
            borrowedSplKey,

            liquidatorKeypair.publicKey,
          ))[0]
        );
      }

      // 2 liquidateIx
      this.bot.logAction(liquidatorKeypair.publicKey.toString());
      this.bot.logAction(collateralMint.toString());
      this.bot.logAction(collateralSplKey.toString());
      this.bot.logAction(borrowedSplKey.toString());
      const liquidateTx = await builder.externalLiquidate(
        liquidatorKeypair,
        this.walletKey,
        collateralSplKey,
        borrowedSplKey,
        collateralMint.toString(),
        borrowedMint.toString(),
        Math.floor(collateralAmt * this.config.getDecimalMultByPoolId(collateralPoolId)),    // receive amount
        Math.ceil(borrowedAmt * this.config.getDecimalMultByPoolId(borrowedPoolId)),        // pay amount
      );
      const liquidateIx = liquidateTx.instructions[0];
      instructions.push(liquidateIx);

      // 3. sell collateral to USDC
      if (collateralTokId != TokenID.USDC) {
        if(!(collateralTokId in supportedMarkets)) {
          throw new Error(`Unsupported collateral type of ${collateralTokId}!`);
        }
        const usdcAmount = collateralAmt * this.poolIdToPrice[collateralPoolId] / this.poolIdToPrice[usdcPoolId];
        invariant(usdcAmount >= 0, `Bad USDC amount: ${usdcAmount}`);

        const swapper = supportedMarkets[collateralTokId];
        invariant(swapper !== undefined, `${collateralTokId} not in supportedMarket!`);

        const collateralTokIdSwappers = tokenIdTranslation[collateralTokId];
        invariant(collateralTokIdSwappers !== undefined, `${collateralTokId} not in tokenIdTranslation`);

        // we care about slippage only if the value of collateral is greater than 10
        // otherwise, step 4.2 should handle it
        if(usdcAmount > 10) {
          const fairValue = usdcAmount * this.config.getDecimalMultByPoolId(usdcPoolId);
          const askUsdcAmount = fairValue * (1 - this.bot.maxTradeSlippage); 

          this.bot.logAction(`Price of ${collateralTokId}: ${this.poolIdToPrice[collateralPoolId] }`);
          this.bot.logAction(`Price of USDC: ${this.poolIdToPrice[usdcPoolId] }`);
          this.bot.logAction(`Selling collateral ${collateralAmt} of ${collateralTokId}, valued at ${usdcAmount} USDC, back to at least ${askUsdcAmount} (native) USDC`);

          instructions.push(
            (await swapper.createSwapInstructions(
              collateralTokIdSwappers,
              collateralAmt * this.config.getDecimalMultByPoolId(collateralPoolId),
              collateralSplKey,

              swappers.TokenID.USDC,
              askUsdcAmount,
              usdcSplKey,

              liquidatorKeypair.publicKey,
            ))[0]
          );
        }
      }

      if(instructions.length <= 2) {
        const tx = new Transaction();
        instructions.forEach(ix=>{tx.add(ix)});
        await sendAndConfirm(connection, tx, [liquidatorKeypair]);
      }
      else {
        // separate into 2 transactions, with first 2 grouped together
        const tx1 = new Transaction();
        instructions.slice(0, 2).forEach(ix=>{tx1.add(ix)});
        await sendAndConfirm(connection, tx1, [liquidatorKeypair]);

        const tx2 = new Transaction().add(instructions[2]);
        await sendAndConfirm(connection, tx2, [liquidatorKeypair]);
      }

      // 4.1 clears residual in borrowed token
      if(this.bot.clearResidual && borrowedTokId != TokenID.USDC) {
        const borrowedSplInfo = await connection.getParsedAccountInfo(borrowedSplKey);
        const leftOver = parseInt((borrowedSplInfo.value?.data as any).parsed.info.tokenAmount.amount);
        if(leftOver > 0) {
          this.bot.logAction(`Selling residual ${leftOver} of ${borrowedTokId}`);
          const swapper = supportedMarkets[borrowedTokId];
          invariant(swapper !== undefined);

          const borrowedTokIdSwappers = tokenIdTranslation[borrowedTokId];
          invariant(borrowedTokIdSwappers !== undefined);

          const clearResidualIx = 
            (await swapper.createSwapInstructions(
              borrowedTokIdSwappers,
              leftOver,
              borrowedSplKey,

              swappers.TokenID.USDC,
              0,  // Get as much USDC back as we can. Tolerate arbitrary slippage.
              usdcSplKey,

              liquidatorKeypair.publicKey,
            ))[0];
          const clearTx = new Transaction().add(clearResidualIx);
          await sendAndConfirm(connection, clearTx, [liquidatorKeypair]);
        }
      }

      // 4.2 clears residual in collateral token
      if(this.bot.clearResidual && collateralTokId != TokenID.USDC) {
        const collateralSplInfo = await connection.getParsedAccountInfo(collateralSplKey);
        const leftOver = parseInt((collateralSplInfo.value?.data as any).parsed.info.tokenAmount.amount);
        if(leftOver > 0) {
          this.bot.logAction(`Selling residual ${leftOver} of ${collateralTokId}`);
          const swapper = supportedMarkets[collateralTokId];
          invariant(swapper !== undefined);

          const collateralTokIdSwappers = tokenIdTranslation[collateralTokId];
          invariant(collateralTokIdSwappers !== undefined);

          const clearResidualIx = 
            (await swapper.createSwapInstructions(
              collateralTokIdSwappers,
              leftOver,
              collateralSplKey,

              swappers.TokenID.USDC,
              0,  // Get as much USDC back as we can. Tolerate arbitrary slippage.
              usdcSplKey,

              liquidatorKeypair.publicKey,
            ))[0];
          const clearTx = new Transaction().add(clearResidualIx);
          await sendAndConfirm(connection, clearTx, [liquidatorKeypair]);
        }
      }
    }
    catch(e) {
      this.bot.logAction((e as unknown as Error).message);
      this.bot.logAction((e as unknown as Error).stack!);
    }
  }
}
