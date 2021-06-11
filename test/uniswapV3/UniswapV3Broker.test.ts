import { expect } from "chai"
import { parseEther } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { TestERC20, TestUniswapV3Broker, UniswapV3Pool } from "../../typechain"
import { poolFixture } from "../shared/fixtures"
import { encodePriceSqrt, token01toBaseQuote } from "../shared/utilities"

describe("UniswapV3Broker", () => {
    let pool: UniswapV3Pool
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let uniswapV3Broker: TestUniswapV3Broker

    beforeEach(async () => {
        const { factory, pool: _pool, base, quote } = await waffle.loadFixture(poolFixture)
        pool = _pool
        baseToken = base
        quoteToken = quote

        const UniswapV3BrokerFactory = await ethers.getContractFactory("TestUniswapV3Broker")
        uniswapV3Broker = (await UniswapV3BrokerFactory.deploy(factory.address)) as TestUniswapV3Broker

        // broker has the only permission to mint vToken
        await baseToken.setMinter(uniswapV3Broker.address)
        await quoteToken.setMinter(uniswapV3Broker.address)
    })

    // https://docs.google.com/spreadsheets/d/1H8Sn0YHwbnEjhhA03QOVfOFPPFZUX5Uasg14UY9Gszc/edit#gid=1867451918
    describe("# mint", () => {
        it("mint range order above current price", async () => {
            await pool.initialize(encodePriceSqrt(1, 1))

            // when above price, token1 = 0
            const token0Amount = parseEther("0.000816820841")
            const token1Amount = "0"
            const { baseAmount, quoteAmount } = token01toBaseQuote(
                baseToken.address,
                quoteToken.address,
                token0Amount,
                token1Amount,
            )

            await expect(
                uniswapV3Broker.mint({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    tickLower: 50000,
                    tickUpper: 50200,
                    baseAmount,
                    quoteAmount,
                }),
            )
                .to.emit(pool, "Mint")
                .withArgs(
                    uniswapV3Broker.address,
                    uniswapV3Broker.address,
                    50000,
                    50200,
                    "999999999994411796", // around 1
                    token0Amount,
                    token1Amount,
                )
        })

        it("mint range order under current price", async () => {
            await pool.initialize(encodePriceSqrt(200, 1))

            // when under price, token0 = 0
            const token0Amount = "0"
            const token1Amount = parseEther("0.122414646")
            const { baseAmount, quoteAmount } = token01toBaseQuote(
                baseToken.address,
                quoteToken.address,
                token0Amount,
                token1Amount,
            )

            await expect(
                uniswapV3Broker.mint({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    tickLower: "50000",
                    tickUpper: "50200",
                    baseAmount,
                    quoteAmount,
                }),
            )
                .to.emit(pool, "Mint")
                .withArgs(
                    uniswapV3Broker.address,
                    uniswapV3Broker.address,
                    50000,
                    50200,
                    "1000000000109464931", // around 1
                    token0Amount,
                    token1Amount,
                )
        })
    })
})
