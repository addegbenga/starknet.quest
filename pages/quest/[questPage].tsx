import { NextPage } from "next";
import React, { useEffect, useState } from "react";
import homeStyles from "../../styles/Home.module.css";
import styles from "../../styles/quests.module.css";
import NftDisplay from "../../components/quests/nftDisplay";
import Task from "../../components/quests/task";
import Reward from "../../components/quests/reward";
import quests_nft_abi from "../../abi/quests_nft_abi.json";

import {
  Call,
  useAccount,
  useStarknet,
  useStarknetExecute,
} from "@starknet-react/core";
import { useRouter } from "next/router";
import { hexToDecimal } from "../../utils/feltService";
import {
  NFTItem,
  QueryError,
  QuestDocument,
  UserTask,
} from "../../types/backTypes";
import { Contract } from "starknet";
import BN from "bn.js";
import { Skeleton } from "@mui/material";
import TasksSkeleton from "../../components/UI/tasksSqueleton";
import RewardSkeleton from "../../components/UI/rewardSqueleton";

const splitByNftContract = (
  rewards: EligibleReward[]
): Record<string, EligibleReward[]> => {
  return rewards.reduce(
    (acc: Record<string, EligibleReward[]>, reward: EligibleReward) => {
      if (!acc[reward.nft_contract]) {
        acc[reward.nft_contract] = [];
      }

      acc[reward.nft_contract].push(reward);
      return acc;
    },
    {}
  );
};

const QuestPage: NextPage = () => {
  const router = useRouter();
  useEffect(() => {
    if (!router) return;
    router.push("/");
  }, [router]);

  const { questPage: questId } = router.query;

  const { address } = useAccount();
  const { library } = useStarknet();

  const [quest, setQuest] = useState<QuestDocument>({
    id: 0,
    name: "loading",
    desc: "loading",
    issuer: "loading",
    category: "loading",
    rewards_endpoint: "",
    logo: "",
    rewards_img: "",
    rewards_title: "loading",
    rewards_nfts: [],
  });
  const [tasks, setTasks] = useState<UserTask[]>([]);
  const [rewardsEnabled, setRewardsEnabled] = useState<boolean>(false);
  const [eligibleRewards, setEligibleRewards] = useState<
    Record<string, EligibleReward[]>
  >({});
  const [unclaimedRewards, setUnclaimedRewards] = useState<EligibleReward[]>(
    []
  );
  const [mintCalldata, setMintCalldata] = useState<Call[]>();
  const { execute: executeMint } = useStarknetExecute({
    calls: mintCalldata,
  });

  // this fetches quest data
  useEffect(() => {
    if (router) return;

    fetch(`/api/get_quest?id=${questId}`)
      .then((response) => response.json())
      .then((data: QuestDocument | QueryError) => {
        if ((data as QuestDocument).name) {
          setQuest(data as QuestDocument);
        }
      });
  }, [questId]);

  // this fetches all tasks of this quest from db
  useEffect(() => {
    if (router) return;

    if (questId) {
      // If a call was made with an address in the first second, the call with 0 address should be cancelled
      let shouldFetchWithZeroAddress = true;

      // Set a 1-second timer to allow time for address loading
      const timer = setTimeout(() => {
        // If address isn't loaded after 1 second, make the API call with the zero address
        if (shouldFetchWithZeroAddress) {
          fetch(`/api/get_tasks?quest_id=${questId}&addr=O`)
            .then((response) => response.json())
            .then((data: UserTask[] | QueryError) => {
              if ((data as UserTask[]).length) setTasks(data as UserTask[]);
            });
        }
      }, 1000);

      // If the address is loaded before the 1-second timer, make the API call with the loaded address
      if (address) {
        shouldFetchWithZeroAddress = false;
        clearTimeout(timer);
        fetch(
          `/api/get_tasks?quest_id=${questId}&addr=${hexToDecimal(address)}`
        )
          .then((response) => response.json())
          .then((data: UserTask[] | QueryError) => {
            if ((data as UserTask[]).length) setTasks(data as UserTask[]);
          });
      }

      // Clear the timer when component unmounts or dependencies change to prevent memory leaks
      return () => {
        clearTimeout(timer);
      };
    }
  }, [questId, address]);

  const refreshRewards = (
    quest: QuestDocument,
    address: string | undefined
  ) => {
    if (address && quest.rewards_endpoint) {
      fetch(`${quest.rewards_endpoint}?addr=${hexToDecimal(address)}`)
        .then((response) => response.json())
        .then((data) => {
          if (data.rewards) {
            setEligibleRewards(splitByNftContract(data.rewards));
          }
        });
    }
  };

  // this fetches all rewards claimable by the user
  useEffect(() => {
    if (router) return;

    refreshRewards(quest, address);
  }, [quest, address]);

  // this filters the claimable rewards to find only the unclaimed ones (on chain)
  useEffect(() => {
    (async () => {
      let unclaimed: EligibleReward[] = [];
      for (const contractAddr in eligibleRewards) {
        const perContractRewards = eligibleRewards[contractAddr];
        const calldata = [];
        for (const reward of perContractRewards) {
          calldata.push([
            questId as string,
            reward.task_id.toString(),
            address as string,
          ]);
        }
        const contract = new Contract(quests_nft_abi, contractAddr, library);

        const result = await (
          await contract.call("get_tasks_status", [calldata])
        ).status.map((x: BN) => x.toNumber());
        const unclaimedPerContractRewards = perContractRewards.filter(
          (_, index) => result[index] === 0
        );
        unclaimed = unclaimed.concat(unclaimedPerContractRewards);
      }
      setUnclaimedRewards(unclaimed);
    })();
  }, [questId, eligibleRewards]);

  // this builds multicall for minting rewards
  useEffect(() => {
    const calldata: Call[] = [];
    unclaimedRewards.forEach((reward) => {
      calldata.push({
        contractAddress: reward.nft_contract,
        entrypoint: "mint",
        calldata: [
          reward.token_id,
          0,
          questId?.toString(),
          reward.task_id,
          reward.sig[0],
          reward.sig[1],
        ],
      });
    });
    if (unclaimedRewards && unclaimedRewards.length > 0) {
      setRewardsEnabled(true);
    } else setRewardsEnabled(false);
    setMintCalldata(calldata);
  }, [questId, unclaimedRewards]);

  return (
    <div className={homeStyles.screen}>
      <div className={styles.imageContainer}>
        {quest.issuer === "loading" ? (
          <RewardSkeleton />
        ) : (
          <NftDisplay
            issuer={{
              name: quest.issuer,
              logoFavicon: quest.logo,
            }}
            nfts={quest.rewards_nfts.map((nft: NFTItem) => {
              return { imgSrc: nft.img, level: nft.level };
            })}
          />
        )}
      </div>
      <div className={styles.descriptionContainer}>
        {quest.name === "loading" ? (
          <Skeleton
            variant="text"
            width={400}
            sx={{ fontSize: "2rem", bgcolor: "grey.900" }}
          />
        ) : (
          <h1 className="title mt-5 mw-90">{quest.name}</h1>
        )}
        {quest.desc === "loading" ? (
          <Skeleton
            variant="text"
            width={350}
            sx={{ fontSize: "0.8rem", bgcolor: "grey.900" }}
          />
        ) : (
          <p className="text-center max-w-lg">{quest.desc}</p>
        )}
      </div>
      <div className={styles.taskContainer}>
        {tasks.length === 0 || quest.rewards_title === "loading" ? (
          <TasksSkeleton />
        ) : (
          <>
            {tasks.map((task) => (
              <Task
                key={task.id}
                name={task.name}
                description={task.desc}
                href={task.href}
                cta={task.cta}
                verifyEndpoint={`${task.verify_endpoint}?address=${address}`}
                refreshRewards={() => refreshRewards(quest, address)}
                wasVerified={task.completed}
              />
            ))}
            <Reward
              reward={quest.rewards_title}
              imgSrc={quest.rewards_img}
              onClick={() => {
                executeMint();
                setRewardsEnabled(false);
              }}
              disabled={!rewardsEnabled}
            />
          </>
        )}
      </div>
    </div>
  );
};

export default QuestPage;