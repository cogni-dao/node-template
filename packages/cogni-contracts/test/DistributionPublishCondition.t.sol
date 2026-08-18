// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
pragma solidity ^0.8.17;

import {Action} from "@aragon/osx-commons-contracts/src/executors/IExecutor.sol";
import {DistributionPublishCondition} from "../src/distribution-publish-condition/DistributionPublishCondition.sol";

contract MockMerkleDistributor {
    bytes32 public merkleRoot;

    function setLiveRoot(bytes32 root) external {
        merkleRoot = root;
    }
}

contract DistributionPublishConditionTest {
    bytes4 private constant EXECUTE_SELECTOR = bytes4(keccak256("execute(bytes32,(address,uint256,bytes)[],uint256)"));
    bytes4 private constant MINT_SELECTOR = bytes4(keccak256("mint(address,uint256)"));
    bytes4 private constant SET_ROOT_SELECTOR = bytes4(keccak256("setMerkleRoot(bytes32)"));

    address private constant TOKEN = address(0x1111);
    bytes32 private constant ROOT_ONE = bytes32(uint256(1));
    bytes32 private constant ROOT_TWO = bytes32(uint256(2));

    MockMerkleDistributor private distributor;
    DistributionPublishCondition private condition;

    function setUp() public {
        distributor = new MockMerkleDistributor();
        condition = new DistributionPublishCondition(TOKEN, address(distributor));
    }

    function testStaleSecondPublishIsDeniedBeforeExecution() public {
        bytes memory firstPublish = _publishData(bytes32(0), ROOT_ONE, 0);
        require(_isGranted(firstPublish), "fresh publish denied");

        distributor.setLiveRoot(ROOT_ONE);

        require(!_isGranted(firstPublish), "stale publish remained authorized");
        require(_isGranted(_publishData(ROOT_ONE, ROOT_TWO, 0)), "next CAS publish denied");
    }

    function testAllowFailureMapIsRejected() public {
        require(!_isGranted(_publishData(bytes32(0), ROOT_ONE, 1)), "failure bitmap allowed");
    }

    function testRootMustAdvance() public {
        distributor.setLiveRoot(ROOT_ONE);
        require(!_isGranted(_publishData(ROOT_ONE, ROOT_ONE, 0)), "same root allowed");
    }

    function _isGranted(bytes memory data) private view returns (bool) {
        return condition.isGranted(address(0), address(0), bytes32(0), data);
    }

    function _publishData(bytes32 expectedRoot, bytes32 newRoot, uint256 allowFailureMap)
        private
        view
        returns (bytes memory)
    {
        Action[] memory actions = new Action[](2);
        actions[0] = Action({
            to: TOKEN, value: 0, data: abi.encodeWithSelector(MINT_SELECTOR, address(distributor), uint256(1))
        });
        actions[1] =
            Action({to: address(distributor), value: 0, data: abi.encodeWithSelector(SET_ROOT_SELECTOR, newRoot)});
        return abi.encodeWithSelector(EXECUTE_SELECTOR, expectedRoot, actions, allowFailureMap);
    }
}
