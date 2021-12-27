import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import {
    BaseToken,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    TestExchange,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { addOrder, closePosition, q2bExactInput, q2bExactOutput, removeOrder } from "../helper/clearingHouseHelper"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { forward } from "../shared/time"
import { encodePriceSqrt } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("Clearinghouse StopMarket", async () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let accountBalance: TestAccountBalance
    let marketRegistry: MarketRegistry
    let exchange: TestExchange
    let orderBook: OrderBook
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let baseToken2: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let pool2: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let mockedBaseAggregator2: MockContract
    let collateralDecimals: number

    let lowerTick: number, upperTick: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture(false))
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        accountBalance = fixture.accountBalance as TestAccountBalance
        orderBook = fixture.orderBook
        exchange = fixture.exchange as TestExchange
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        baseToken2 = fixture.baseToken2
        quoteToken = fixture.quoteToken
        mockedBaseAggregator = fixture.mockedBaseAggregator
        mockedBaseAggregator2 = fixture.mockedBaseAggregator2
        pool = fixture.pool
        pool2 = fixture.pool2
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("151", 6), 0, 0, 0]
        })

        mockedBaseAggregator2.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("151", 6), 0, 0, 0]
        })

        await pool.initialize(encodePriceSqrt(151.3733069, 1))
        await pool2.initialize(encodePriceSqrt(151.3733069, 1))

        // add pool after it's initialized
        await marketRegistry.addPool(baseToken.address, 10000)
        await marketRegistry.addPool(baseToken2.address, 10000)

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // mint
        collateral.mint(alice.address, parseUnits("10000", collateralDecimals))
        collateral.mint(bob.address, parseUnits("10000", collateralDecimals))
        collateral.mint(carol.address, parseUnits("10000", collateralDecimals))
        await deposit(alice, vault, 10000, collateral)
        await deposit(bob, vault, 10000, collateral)
        await deposit(carol, vault, 10000, collateral)

        // maker add liquidity
        await addOrder(fixture, alice, 50, 5000, lowerTick, upperTick, false, baseToken.address)
        await addOrder(fixture, alice, 50, 5000, lowerTick, upperTick, false, baseToken2.address)
    })

    describe("# pause market", async () => {
        beforeEach(async () => {
            // open position
            await q2bExactInput(fixture, bob, 10, baseToken.address)

            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("100", 6), 0, 0, 0]
            })
        })

        it("force error, can not operate in paused market", async () => {
            // stop market for baseToken
            await baseToken.pause(15 * 60 * 1000)

            // can't open position
            await expect(q2bExactInput(fixture, bob, 10, baseToken.address)).to.be.revertedWith("CH_MNO")

            // can't close position
            await expect(closePosition(fixture, bob, 0, baseToken.address)).to.be.revertedWith("CH_MNO")

            // can't add liquidity
            await expect(
                addOrder(fixture, bob, 1, 10, lowerTick, upperTick, false, baseToken.address),
            ).to.be.revertedWith("CH_MNO")

            // can't remove liquidity
            await expect(removeOrder(fixture, alice, 0, lowerTick, upperTick, baseToken.address)).to.be.revertedWith(
                "CH_MP",
            )
        })

        it("should be able to query unrealized Pnl in paused market", async () => {
            const [, unrealizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)
            expect(unrealizedPnl).not.eq("0")
        })

        describe("funding payment", async () => {
            beforeEach(async () => {
                await forward(1)
                await clearingHouse.settleAllFunding(bob.address)

                // pause market for baseToken
                await baseToken.pause(15 * 60 * 1000)
            })

            it("fundingPayment should not change anymore in paused market", async () => {
                const pendingFundingPayment1 = await exchange.getPendingFundingPayment(bob.address, baseToken.address)
                expect(pendingFundingPayment1).not.eq("0")

                // forward
                await forward(3000)
                const pendingFundingPayment2 = await exchange.getPendingFundingPayment(bob.address, baseToken.address)

                // pendingFundingPayment should not change
                expect(pendingFundingPayment1).to.be.eq(pendingFundingPayment2)
            })

            it("should be able to settle funding", async () => {
                const pendingFundingPayment = await exchange.getPendingFundingPayment(bob.address, baseToken.address)
                const [owedRealizedBefore] = await accountBalance.getPnlAndPendingFee(bob.address)

                // settleFunding
                await expect(clearingHouse.settleAllFunding(bob.address)).to.be.not.reverted

                const [owedRealizedAfter] = await accountBalance.getPnlAndPendingFee(bob.address)
                expect(owedRealizedAfter.sub(owedRealizedBefore).mul(-1)).to.be.eq(pendingFundingPayment)
            })
        })

        describe("liquidate", async () => {
            it("should be able to liquidate if one market is paused", async () => {
                await addOrder(fixture, alice, 300, 30000, lowerTick, upperTick, false, baseToken.address)

                // add liquidity to baseToken2 market
                await addOrder(fixture, bob, 50, 5000, lowerTick, upperTick, false, baseToken2.address)

                // swap on baseToken market
                await q2bExactInput(fixture, bob, 10000, baseToken.address)

                // pause baseToken2 market
                await baseToken2.pause(600)

                // drop price on baseToken market
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("0.0001", 6), 0, 0, 0]
                })

                // hasOrderInOpenOrClosedMarket check
                expect(await accountBalance.hasOrderInOpenOrClosedMarket(bob.address)).to.be.eq(false)

                // liquidate bob on baseToken market
                await expect(clearingHouse.liquidate(bob.address, baseToken.address)).to.emit(
                    clearingHouse,
                    "PositionLiquidated",
                )
            })
        })
    })

    describe("# close market", async () => {
        describe("remove liquidity", async () => {
            beforeEach(async () => {
                await q2bExactOutput(fixture, bob, "0.1", baseToken.address)
                // close market
                await baseToken.pause(600)
                await baseToken["close(uint256)"](parseEther("100"))
            })

            it("should be able to removeLiquidity in closed market", async () => {
                const { liquidity } = await orderBook.getOpenOrder(
                    alice.address,
                    baseToken.address,
                    lowerTick,
                    upperTick,
                )
                expect(liquidity).to.be.gt("0")
                await removeOrder(fixture, alice, liquidity, lowerTick, upperTick, baseToken.address)
                expect(await orderBook.hasOrder(alice.address, [baseToken.address])).to.be.eq(false)
            })

            it("remove liquidity and settled to taker position", async () => {
                // removeLiquidity
                const { liquidity } = await orderBook.getOpenOrder(
                    alice.address,
                    baseToken.address,
                    lowerTick,
                    upperTick,
                )
                await removeOrder(fixture, alice, liquidity, lowerTick, upperTick, baseToken.address)

                const positionSizeAfterClosed = await accountBalance.getTakerPositionSize(
                    alice.address,
                    baseToken.address,
                )
                expect(positionSizeAfterClosed).to.be.closeTo(parseEther("-0.1"), 1)
            })
        })

        describe("close position", async () => {
            beforeEach(async () => {
                await q2bExactOutput(fixture, bob, "0.1", baseToken.address)
                // close market
                await baseToken.pause(600)
                await baseToken["close(uint256)"](parseEther("100"))
            })

            it("force error, trader still has order in closed market, can not close position", async () => {
                await expect(
                    clearingHouse.closePositionInClosedMarket(alice.address, baseToken.address),
                ).to.be.revertedWith("CH_HOICM")
            })

            it("should be able to closePositionInClosedMarket in closed market", async () => {
                const positionSize = await accountBalance.getTakerPositionSize(bob.address, baseToken.address)
                expect(positionSize).to.be.eq(parseEther("0.1"))

                await expect(clearingHouse.closePositionInClosedMarket(bob.address, baseToken.address)).to.be.emit(
                    clearingHouse,
                    "PositionChanged",
                )
            })

            it("should deregister closed market baseToken", async () => {
                await clearingHouse.closePositionInClosedMarket(bob.address, baseToken.address)

                const baseTokens = await accountBalance.getBaseTokens(bob.address)
                expect(baseTokens.length).to.be.eq(0)
            })
        })

        describe("cancel order", async () => {
            it("can cancel order in closed market if bob can be liquidated", async () => {
                await addOrder(fixture, alice, 300, 30000, lowerTick, upperTick, false, baseToken.address)

                // add liquidity to baseToken2 market
                await addOrder(fixture, bob, 50, 5000, lowerTick, upperTick, false, baseToken2.address)

                // swap on baseToken market
                await q2bExactInput(fixture, bob, 10000, baseToken.address)

                // pause baseToken2 market
                await baseToken2.pause(600)

                // can not cancel order in paused market
                await expect(clearingHouse.cancelAllExcessOrders(bob.address, baseToken2.address)).to.be.revertedWith(
                    "CH_MP",
                )

                // close baseToken2 market
                await baseToken2["close(uint256)"](parseEther("0.0001"))

                // drop price on baseToken market
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("0.0001", 6), 0, 0, 0]
                })

                // hasOrderInOpenOrClosedMarket check
                expect(await accountBalance.hasOrderInOpenOrClosedMarket(bob.address)).to.be.eq(true)

                // liquidate bob on baseToken market
                await expect(clearingHouse.cancelAllExcessOrders(bob.address, baseToken2.address)).to.emit(
                    clearingHouse,
                    "LiquidityChanged",
                )

                expect(await accountBalance.hasOrder(bob.address)).to.be.eq(false)
            })
        })

        describe("PnL accounting after close position", async () => {
            beforeEach(async () => {
                // open position on two market
                await q2bExactInput(fixture, bob, 10, baseToken.address)
                await q2bExactInput(fixture, bob, 10, baseToken2.address)

                // close baseToken pool
                await baseToken.pause(600)
            })

            it("taker has positive pnl in closed market", async () => {
                await baseToken["close(uint256)"](parseEther("1000"))

                // taker settle on closed market
                const closedMarketPositionSize = await accountBalance.getTakerPositionSize(
                    bob.address,
                    baseToken.address,
                )
                const closedMarketQuoteBalance = await accountBalance.getTotalOpenNotional(
                    bob.address,
                    baseToken.address,
                )
                const pendingFundingPayment = await exchange.getPendingFundingPayment(bob.address, baseToken.address)

                const expectedPnl = closedMarketPositionSize.mul("1000").add(closedMarketQuoteBalance)

                await expect(clearingHouse.closePositionInClosedMarket(bob.address, baseToken.address))
                    .to.emit(accountBalance, "PnlRealized")
                    .withArgs(bob.address, expectedPnl)

                const [takerOwedRealizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)
                expect(takerOwedRealizedPnl).to.be.eq(expectedPnl.sub(pendingFundingPayment))

                // maker settle on closed market
                const { liquidity } = await orderBook.getOpenOrder(
                    alice.address,
                    baseToken.address,
                    lowerTick,
                    upperTick,
                )
                await removeOrder(fixture, alice, liquidity, lowerTick, upperTick, baseToken.address)
                await clearingHouse.closePositionInClosedMarket(alice.address, baseToken.address)

                const [makerOwedRealizedPnl] = await accountBalance.getPnlAndPendingFee(alice.address)
                expect(makerOwedRealizedPnl).to.be.closeTo(takerOwedRealizedPnl.mul("-1"), 1010) // error of 1wei * 1000
            })

            it("taker has negative pnl in closed market", async () => {
                await baseToken["close(uint256)"](parseEther("50"))

                const closedMarketPositionSize = await accountBalance.getTakerPositionSize(
                    bob.address,
                    baseToken.address,
                )
                const closedMarketQuoteBalance = await accountBalance.getTotalOpenNotional(
                    bob.address,
                    baseToken.address,
                )
                const pendingFundingPayment = await exchange.getPendingFundingPayment(bob.address, baseToken.address)

                const expectedPnl = closedMarketPositionSize.mul("50").add(closedMarketQuoteBalance)

                await expect(clearingHouse.closePositionInClosedMarket(bob.address, baseToken.address))
                    .to.emit(accountBalance, "PnlRealized")
                    .withArgs(bob.address, expectedPnl)

                const [takerOwedRealizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)
                expect(takerOwedRealizedPnl).to.be.eq(expectedPnl.sub(pendingFundingPayment))

                // maker settle on closed market
                const { liquidity } = await orderBook.getOpenOrder(
                    alice.address,
                    baseToken.address,
                    lowerTick,
                    upperTick,
                )
                await removeOrder(fixture, alice, liquidity, lowerTick, upperTick, baseToken.address)
                await clearingHouse.closePositionInClosedMarket(alice.address, baseToken.address)

                const [makerOwedRealizedPnl] = await accountBalance.getPnlAndPendingFee(alice.address)
                expect(makerOwedRealizedPnl).to.be.closeTo(takerOwedRealizedPnl.mul("-1"), 60) // error of 1wei * 50
            })
        })

        describe("check free collateral and withdrawal after stopping market", async () => {
            it("taker has positive pnl on closed market", async () => {
                // open position on two market
                await q2bExactInput(fixture, bob, 10, baseToken.address)
                await q2bExactInput(fixture, bob, 10, baseToken2.address)

                // close baseToken pool
                await baseToken.pause(600)
                await baseToken["close(uint256)"](parseEther("1000"))

                // accountValue: 10055.1280557316, totalCollateralValue: 10000
                // freeCollateral = 10000 - 2 = 9998
                const pendingFundingPayment = await exchange.getPendingFundingPayment(bob.address, baseToken.address)
                const freeCollateralBefore = await vault.getFreeCollateral(bob.address)
                expect(freeCollateralBefore).to.be.closeTo(
                    parseUnits("9998", collateralDecimals).sub(pendingFundingPayment.div(1e12)),
                    5,
                )

                // taker settle on closed market
                await clearingHouse.closePositionInClosedMarket(bob.address, baseToken.address)

                // closedMarketPositionSize: 0.065271988421256964, closedMarketQuoteBalance: -10
                // accountValue: 10055.1280550, totalCollateralValue: 10000 + closedMarketPositionSize.mul("1000").add(closedMarketQuoteBalance) = 10055.271988
                // freeCollateral = 10055.1280550 - 1 = 10054.128055
                const freeCollateralAfter = await vault.getFreeCollateral(bob.address)
                expect(freeCollateralAfter).to.be.eq(parseUnits("10054.128055", collateralDecimals))

                await vault.connect(bob).withdraw(collateral.address, freeCollateralAfter)

                expect(await vault.getFreeCollateral(bob.address)).to.be.eq("0")
            })

            it("taker has negative pnl on closed market", async () => {
                // open position on two market
                await q2bExactInput(fixture, bob, 10, baseToken.address)
                await q2bExactInput(fixture, bob, 100, baseToken2.address)

                // make profit on baseToken market
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("200", 6), 0, 0, 0]
                })

                // close baseToken pool
                await baseToken2.pause(600)
                await baseToken2["close(uint256)"](parseEther("50"))

                // accountValue: 9935.1201076808, totalCollateralValue: 10000
                // freeCollateral = 9935.1201076808 - 11 = 9924.1201076808
                const freeCollateralBefore = await vault.getFreeCollateral(bob.address)
                expect(freeCollateralBefore).to.be.closeTo(parseUnits("9924.120107", collateralDecimals), 2)

                // taker settle on closed market
                await clearingHouse.closePositionInClosedMarket(bob.address, baseToken2.address)

                // closedMarketPositionSize: 0.6413142475, closedMarketQuoteBalance: -100, fundingPayment: 0.00004771-0.00006044
                // accountValue: 9935.120122790010963572, totalCollateralValue: 10000 + closedMarketPositionSize.mul("50").add(closedMarketQuoteBalance) = 9932.065712375
                // freeCollateral = 9932.065712375 - 0.00004770542396 + 0.00006044 - 1 = 9931.065725
                const freeCollateralAfter = await vault.getFreeCollateral(bob.address)
                expect(freeCollateralAfter).to.be.eq(parseUnits("9931.065725", collateralDecimals))

                await vault.connect(bob).withdraw(collateral.address, freeCollateralAfter)
            })
        })

        describe("accounting in closed market", async () => {
            beforeEach(async () => {
                // open position on two market
                await q2bExactInput(fixture, bob, 10, baseToken.address)

                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("100", 6), 0, 0, 0]
                })

                // close baseToken pool
                await baseToken.pause(600)
                await baseToken["close(uint256)"](parseEther("50"))
            })

            it("unrealized pnl accounting", async () => {
                const bobStoppedMarketPositionSize = await accountBalance.getTakerPositionSize(
                    bob.address,
                    baseToken.address,
                )
                const bobStoppedMarketQuoteBalance = await accountBalance.getTotalOpenNotional(
                    bob.address,
                    baseToken.address,
                )
                const [, bobUnrealizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)

                expect(bobUnrealizedPnl).to.be.eq(
                    bobStoppedMarketPositionSize.mul("50").add(bobStoppedMarketQuoteBalance),
                )

                const aliceStoppedMarketPositionSize = await accountBalance.getTotalPositionSize(
                    bob.address,
                    baseToken.address,
                )
                const aliceStoppedMarketQuoteBalance = await accountBalance.getTotalOpenNotional(
                    bob.address,
                    baseToken.address,
                )
                const [, aliceUnrealizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)

                expect(aliceUnrealizedPnl).to.be.eq(
                    aliceStoppedMarketPositionSize.mul("50").add(aliceStoppedMarketQuoteBalance),
                )
            })

            it("total position value accounting", async () => {
                const bobStoppedMarketPositionSize = await accountBalance.getTotalPositionSize(
                    bob.address,
                    baseToken.address,
                )
                const bobStoppedMarketPositionValue = await accountBalance.getTotalPositionValue(
                    bob.address,
                    baseToken.address,
                )

                const aliceStoppedMarketPositionSize = await accountBalance.getTotalPositionSize(
                    alice.address,
                    baseToken.address,
                )
                const aliceStoppedMarketPositionValue = await accountBalance.getTotalPositionValue(
                    alice.address,
                    baseToken.address,
                )

                expect(bobStoppedMarketPositionValue).to.be.eq(bobStoppedMarketPositionSize.mul("50"))
                expect(aliceStoppedMarketPositionValue).to.be.eq(aliceStoppedMarketPositionSize.mul("50"))
            })
        })
    })
})
