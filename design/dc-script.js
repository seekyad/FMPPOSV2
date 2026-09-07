alse };

  renderVals() {
    const s = this.state;
    const DUE = s.cents;
    const digit = d => () => this.setState(st => ({ cents: Math.min(st.cents * 10 + d, 9999999) }));
    const BASE = 310, MULT = { Good: 1, Fair: .75, Broken: .4 };
    const NOTES = {
      Good: 'Clean screen, holds charge, no frame damage',
      Fair: 'Light scratches or worn battery — resells as B-grade',
      Broken: 'Cracked glass or dead board — parts value only'
    };
    const auto = Math.round(BASE * MULT[s.cond] * (s.payout === 'Credit' ? 1.1 : 1));
    const isManual = s.manual !== null;
    const offer = isManual ? (parseFloat(s.manual) || 0) : auto;
    const condStyle = c => s.cond === c
      ? { bg: '#FDEDE1', br: '#F97316' }
      : { bg: '#fff', br: '#E3E6EA' };
    const cp = s.callPri;
    return {
      callPri: cp,
      toggleCallPri: () => this.setState(st => ({ callPri: !st.callPri })),
      cpBg: cp ? '#6D28D9' : '#fff',
      cpBorder: cp ? '#6D28D9' : '#E3E6EA',
      cpColor: cp ? '#fff' : '#4B5158',
      cpIconColor: cp ? '#fff' : '#9CA3AF',
      cpIcon: cp ? 'bi bi-telephone-fill' : 'bi bi-telephone',
      cpLabel: cp ? 'Call priority on' : 'Flag as call priority',
      cpNote: cp
        ? 'Ticket #R-2294 will show a Call flag on the Repairs board'
        : 'Customer wants a call as soon as it’s done',

      customOpen: s.customOpen,
      openCustom: () => this.setState({ customOpen: true, cents: 0, tendered: 0 }),
      closeCustom: () => this.setState({ customOpen: false }),
      stopClose: e => e.stopPropagation(),
      k0: digit(0), k1: digit(1), k2: digit(2), k3: digit(3), k4: digit(4),
      k5: digit(5), k6: digit(6), k7: digit(7), k8: digit(8), k9: digit(9),
      k00: () => this.setState(st => ({ cents: Math.min(st.cents * 100, 9999999) })),
      back: () => this.setState(st => ({ cents: Math.floor(st.cents / 10) })),
      clear: () => this.setState({ cents: 0 }),
      p5: () => this.setState({ tendered: 500 }),
      p10: () => this.setState({ tendered: 1000 }),
      p15: () => this.setState({ tendered: 1500 }),
      p20: () => this.setState({ tendered: 2000 }),
      p50: () => this.setState({ tendered: 5000 }),
      p100: () => this.setState({ tendered: 10000 }),
      amount: '$' + (s.cents / 100).toFixed(2),
      dueLabel: '$' + (DUE / 100).toFixed(2),
      tenderedLabel: '$' + (s.tendered / 100).toFixed(2),
      balanceLabel: s.tendered >= DUE ? 'Change back' : 'Still due',
      balanceValue: '$' + (Math.abs(DUE - s.tendered) / 100).toFixed(2),
      balanceBg: s.tendered >= DUE ? '#E7F6EE' : '#FDEBE9',
      balanceBorder: s.tendered >= DUE ? '#BCE5CE' : '#F7C7C1',
      balanceColor: s.tendered >= DUE ? '#15803D' : '#B42318',
      addLabel: 'Add to sale · $' + (s.cents / 100).toFixed(2),

      tradeOpen: s.tradeOpen,
      openTrade: () => this.setState({ tradeOpen: true, cond: 'Good', payout: 'Cash', manual: null }),
      isManual: isManual,
      isAuto: !isManual,
      manualValue: s.manual === null ? '' : s.manual,
      startManual: () => this.setState({ manual: String(auto) }),
      onManual: e => this.setState({ manual: e.target.value.replace(/[^0-9.]/g, '') }),
      resetManual: () => this.setState({ manual: null }),
      autoLabel: 'Suggested $' + auto.toFixed(2),
      closeTrade: () => this.setState({ tradeOpen: false }),
      setGood: () => this.setState({ cond: 'Good' }),
      setFair: () => this.setState({ cond: 'Fair' }),
      setBroken: () => this.setState({ cond: 'Broken' }),
      setCash: () => this.setState({ payout: 'Cash' }),
      setCredit: () => this.setState({ payout: 'Credit' }),
      goodBg: condStyle('Good').bg, goodBorder: condStyle('Good').br,
      fairBg: condStyle('Fair').bg, fairBorder: condStyle('Fair').br,
      brokenBg: condStyle('Broken').bg, brokenBorder: condStyle('Broken').br,
      cashBg: s.payout === 'Cash' ? '#111827' : '#fff',
      cashColor: s.payout === 'Cash' ? '#fff' : '#17191C',
      creditBg: s.payout === 'Credit' ? '#111827' : '#fff',
      creditColor: s.payout === 'Credit' ? '#fff' : '#17191C',
      offerLabel: '$' + offer.toFixed(2),
      offerNote: isManual
        ? 'Manual override · suggested was $' + auto.toFixed(2)
        : (s.payout === 'Credit' ? 'Store credit · includes 10% bonus' : 'Cash from drawer'),
      condNote: NOTES[s.cond],
      acceptLabel: (s.payout === 'Credit' ? 'Issue store credit · $' : 'Pay out cash · $') + offer.toFixed(2)
    };
  }
}
</script>


</body></html>