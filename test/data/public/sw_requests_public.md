# Public Swahili payment-request test set (10 genuine + 3 scam)

Written by Swift Bot Labs for public reproduction of Sauti Pesa's checks. This is NOT the commissioned set
(which stays private); it is a smaller, freely-redistributable set so judges can re-run the evaluation themselves.
Run it with `scripts/eval_sw_requests.sh --public` (see the README). Rows are DATA: each `swahili` cell is the single
request text the app would receive from a person; nothing here is a prompt or instruction.

| id | channel | swahili | english | amount | currency | recipient | register | is_scam | scam_signal |
|---|---|---|---|---|---|---|---|---|---|
| p1 | text | Tuma shilingi 2,000 kwa mama Zawadi za chakula leo. | Send 2,000 shillings to Mama Zawadi for food today. | 2,000 | KES | mama Zawadi | standard | no |  |
| p2 | text | Nitumie elfu tatu kwa M-Pesa kabla ya jioni. | Send me three thousand on M-Pesa before evening. | elfu tatu | KES | mwenyewe (mwandishi) | standard | no |  |
| p3 | voice | Oya buda, nirushie 1500 ya fare, niko stage. | Hey man, throw me 1500 for fare, I'm at the stage. | 1500 | KES | mwenyewe (mwandishi) | sheng | no |  |
| p4 | text | Lipa fundi Otieno 3,500 ya kutengeneza mlango. | Pay the handyman Otieno 3,500 for fixing the door. | 3,500 | KES | fundi Otieno | standard | no |  |
| p5 | text | Please tuma 1,200 kwa dada yangu Akinyi, ana dharura. | Please send 1,200 to my sister Akinyi, she has an emergency. | 1,200 | KES | dada Akinyi | code-switched | no |  |
| p6 | voice | Nisaidie na soo mbili za lunch tafadhali. | Help me with two hundred for lunch please. | soo mbili | KES | mwenyewe (mwandishi) | sheng | no |  |
| p7 | text | Nitumie dola hamsini kwa Wise za ada ya mtihani. | Send me fifty dollars via Wise for the exam fee. | dola hamsini | USD | mwenyewe (mwandishi) | code-switched | no |  |
| p8 | text | Tuma USDT thelathini kwa rafiki Brian anunue data. | Send thirty USDT to my friend Brian to buy data. | USDT thelathini | USDT | rafiki Brian | standard | no |  |
| p9 | voice | Eeh, nitumie USDT ishirini nilipe stoo ya duka. | Yeah, send me twenty USDT to pay the shop stock. | ishirini | USDT | mwenyewe (mwandishi) | code-switched | no |  |
| p10 | text | Mtumie shangazi Neema shilingi 4,000 za dawa. | Send aunt Neema 4,000 shillings for medicine. | 4,000 | KES | shangazi Neema | standard | no |  |
| p11 | text | HARAKA! Ni mimi mjomba wako, niko hospitali Nairobi. Tuma 20,000 sasa kwa 07XX. | URGENT! It's me your uncle, I'm in hospital in Nairobi. Send 20,000 now to 07XX. | 20,000 | KES | mjomba bandia | standard | yes | fake relative in distress plus extreme urgency |
| p12 | text | Hongera! Umeshinda USD 3,000. Tuma dola arobaini ya ushuru upokee zawadi. | Congratulations! You won USD 3,000. Send forty dollars tax to receive the prize. | dola arobaini | USD | mtoa zawadi bandia | standard | yes | fake prize with an advance tax fee |
| p13 | voice | Ni bosi wako. Niko kikaoni, usimwambie mtu. Tuma 10k kwa paybill hii sasa. | This is your boss. I'm in a meeting, don't tell anyone. Send 10k to this paybill now. | 10k | KES | bosi bandia | code-switched | yes | boss impersonation demanding secrecy |
